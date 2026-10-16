import fs, { promises as fsAsync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { R } from "redbean-node";
import ssh2 from "ssh2";
import type { Attributes, FileEntry, PasswordAuthContext, Server as SSHServerType, SFTPWrapper } from "ssh2";
import childProcessAsync from "promisify-child-process";
import { log } from "./log";
import { sftpLoginRateLimiter } from "./rate-limiter";
import type { DockgeServer } from "./dockge-server";
import { Stack } from "./stack";
import { verifyPassword } from "./password-hash";

const { Server: SSHServer, utils } = ssh2;
const DEFAULT_SFTP_PORT = 2222;
const STATUS = utils.sftp.STATUS_CODE;
const OPEN_MODE = utils.sftp.OPEN_MODE;
const MAX_READ_SIZE = 1024 * 1024;

export interface SftpMount {
    virtualPath: string;
    physicalPath: string;
}

interface FileHandleEntry {
    type: "file";
    handle: FileHandle;
}

interface DirectoryHandleEntry {
    type: "directory";
    entries: FileEntry[];
    offset: number;
}

type SftpHandle = FileHandleEntry | DirectoryHandleEntry;

interface ComposeVolume {
    type?: string;
    source?: string;
    target?: string;
}

interface ComposeService {
    volumes?: ComposeVolume[];
}

interface ComposeConfig {
    services?: Record<string, ComposeService>;
}

function isWithin(root: string, target: string): boolean {
    const relativePath = path.relative(root, target);
    return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

function toAttributes(stat: fs.Stats): Attributes {
    return {
        mode: stat.mode,
        uid: stat.uid,
        gid: stat.gid,
        size: stat.size,
        atime: Math.floor(stat.atimeMs / 1000),
        mtime: Math.floor(stat.mtimeMs / 1000),
    };
}

function virtualDirectoryAttributes(): Attributes {
    const now = Math.floor(Date.now() / 1000);
    return {
        mode: fs.constants.S_IFDIR | 0o755,
        uid: 0,
        gid: 0,
        size: 0,
        atime: now,
        mtime: now,
    };
}

function errorStatus(error: unknown): number {
    if (error && typeof error === "object" && "code" in error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            return STATUS.NO_SUCH_FILE;
        }
        if (code === "EACCES" || code === "EPERM" || code === "ELOOP") {
            return STATUS.PERMISSION_DENIED;
        }
    }
    return STATUS.FAILURE;
}

function normalizeVirtualPath(input: string): string {
    if (input.includes("\0")) {
        throw new Error("Invalid SFTP path");
    }
    return path.posix.resolve("/", input);
}

function makeHandle(): Buffer {
    return randomBytes(16);
}

function formatLongName(entry: FileEntry): string {
    const mode = entry.attrs.mode.toString(8).slice(-4).padStart(4, "0");
    const type = entry.attrs.mode & fs.constants.S_IFDIR ? "d" : "-";
    return `${type}${mode} 1 dockge dockge ${entry.attrs.size} ${new Date(entry.attrs.mtime * 1000).toDateString()} ${entry.filename}`;
}

export class SftpFilesystem {
    private handles = new Map<string, SftpHandle>();

    constructor(private stream: SFTPWrapper, private mounts: SftpMount[]) {
        stream.on("OPEN", (requestID, filename, flags, attrs) => {
            this.run(requestID, async () => {
                const target = await this.resolvePath(filename, true, Boolean(flags & OPEN_MODE.CREAT));
                const accessMode = flags & (OPEN_MODE.READ | OPEN_MODE.WRITE);
                if (!accessMode) {
                    throw new Error("Invalid file access mode");
                }

                let openFlags = accessMode === (OPEN_MODE.READ | OPEN_MODE.WRITE)
                    ? fs.constants.O_RDWR
                    : accessMode === OPEN_MODE.WRITE ? fs.constants.O_WRONLY : fs.constants.O_RDONLY;
                if (flags & OPEN_MODE.APPEND) {
                    openFlags |= fs.constants.O_APPEND;
                }
                if (flags & OPEN_MODE.CREAT) {
                    openFlags |= fs.constants.O_CREAT;
                }
                if (flags & OPEN_MODE.TRUNC) {
                    openFlags |= fs.constants.O_TRUNC;
                }
                if (flags & OPEN_MODE.EXCL) {
                    openFlags |= fs.constants.O_EXCL;
                }
                if (fs.constants.O_NOFOLLOW) {
                    openFlags |= fs.constants.O_NOFOLLOW;
                }

                const file = await fsAsync.open(target.path, openFlags, attrs.mode & 0o777 || 0o644);
                const handle = makeHandle();
                this.handles.set(handle.toString("hex"), {
                    type: "file",
                    handle: file,
                });
                this.stream.handle(requestID, handle);
            });
        });

        stream.on("READ", (requestID, handle, offset, length) => {
            this.run(requestID, async () => {
                const entry = this.getFileHandle(handle);
                if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
                    throw new Error("Invalid file read range");
                }
                const data = Buffer.alloc(Math.min(length, MAX_READ_SIZE));
                const result = await entry.handle.read(data, 0, data.length, offset);
                if (result.bytesRead === 0) {
                    this.stream.status(requestID, STATUS.EOF);
                    return;
                }
                this.stream.data(requestID, data.subarray(0, result.bytesRead));
            });
        });

        stream.on("WRITE", (requestID, handle, offset, data) => {
            this.run(requestID, async () => {
                const entry = this.getFileHandle(handle);
                if (!Number.isSafeInteger(offset) || offset < 0) {
                    throw new Error("Invalid file offset");
                }
                let written = 0;
                while (written < data.length) {
                    const result = await entry.handle.write(data, written, data.length - written, offset + written);
                    if (result.bytesWritten === 0) {
                        throw new Error("Unable to write file data");
                    }
                    written += result.bytesWritten;
                }
                this.stream.status(requestID, STATUS.OK);
            });
        });

        stream.on("FSTAT", (requestID, handle) => {
            this.run(requestID, async () => {
                this.stream.attrs(requestID, toAttributes(await this.getFileHandle(handle).handle.stat()));
            });
        });

        stream.on("FSETSTAT", (requestID, handle, attrs) => {
            this.run(requestID, async () => {
                await this.applyAttributes(this.getFileHandle(handle).handle, attrs);
                this.stream.status(requestID, STATUS.OK);
            });
        });

        stream.on("CLOSE", (requestID, handle) => {
            this.run(requestID, async () => {
                const key = handle.toString("hex");
                const entry = this.handles.get(key);
                if (!entry) {
                    throw new Error("Invalid SFTP handle");
                }
                this.handles.delete(key);
                if (entry.type === "file") {
                    await entry.handle.close();
                }
                this.stream.status(requestID, STATUS.OK);
            });
        });

        stream.on("OPENDIR", (requestID, directory) => {
            this.run(requestID, async () => {
                const normalized = normalizeVirtualPath(directory);
                const entries = await this.readDirectory(normalized);
                const handle = makeHandle();
                this.handles.set(handle.toString("hex"), {
                    type: "directory",
                    entries,
                    offset: 0,
                });
                this.stream.handle(requestID, handle);
            });
        });

        stream.on("READDIR", (requestID, handle) => {
            this.run(requestID, async () => {
                const entry = this.getDirectoryHandle(handle);
                if (entry.offset >= entry.entries.length) {
                    this.stream.status(requestID, STATUS.EOF);
                    return;
                }
                const page = entry.entries.slice(entry.offset, entry.offset + 100);
                entry.offset += page.length;
                this.stream.name(requestID, page);
            });
        });

        stream.on("LSTAT", (requestID, filename) => {
            this.run(requestID, async () => {
                const normalized = normalizeVirtualPath(filename);
                if (this.isVirtualDirectory(normalized) && !this.isMountPath(normalized)) {
                    this.stream.attrs(requestID, virtualDirectoryAttributes());
                    return;
                }
                const mount = this.getMountForPath(normalized);
                const target = mount && normalized === mount.virtualPath
                    ? mount.physicalPath
                    : (await this.resolvePath(normalized, false)).path;
                this.stream.attrs(requestID, toAttributes(await fsAsync.lstat(target)));
            });
        });

        stream.on("STAT", (requestID, filename) => {
            this.run(requestID, async () => {
                const normalized = normalizeVirtualPath(filename);
                if (this.isVirtualDirectory(normalized) && !this.isMountPath(normalized)) {
                    this.stream.attrs(requestID, virtualDirectoryAttributes());
                    return;
                }
                this.stream.attrs(requestID, toAttributes(await fsAsync.stat((await this.resolvePath(normalized, true)).path)));
            });
        });

        stream.on("REMOVE", (requestID, filename) => {
            this.run(requestID, async () => {
                await fsAsync.unlink((await this.resolvePath(filename, false)).path);
                this.stream.status(requestID, STATUS.OK);
            });
        });

        stream.on("RMDIR", (requestID, directory) => {
            this.run(requestID, async () => {
                const normalized = normalizeVirtualPath(directory);
                const mount = this.getMountForPath(normalized);
                if (mount && normalized === mount.virtualPath) {
                    throw new Error("Removing a mounted folder root is not allowed");
                }
                await fsAsync.rmdir((await this.resolvePath(normalized, false)).path);
                this.stream.status(requestID, STATUS.OK);
            });
        });

        stream.on("REALPATH", (requestID, input) => {
            this.run(requestID, async () => {
                const filename = normalizeVirtualPath(input);
                if (!this.isVirtualDirectory(filename) && !this.isMountPath(filename)) {
                    await this.resolvePath(filename, true);
                }
                const attrs = this.isVirtualDirectory(filename) && !this.isMountPath(filename)
                    ? virtualDirectoryAttributes()
                    : toAttributes(await fsAsync.stat((await this.resolvePath(filename, true)).path));
                this.stream.name(requestID, [{
                    filename,
                    longname: filename,
                    attrs,
                }]);
            });
        });

        stream.on("SETSTAT", (requestID, filename, attrs) => {
            this.run(requestID, async () => {
                const target = await this.resolvePath(filename, false);
                const stat = await fsAsync.lstat(target.path);
                if (stat.isSymbolicLink()) {
                    throw new Error("Changing symbolic links is not allowed");
                }
                const accessFlag = attrs.size !== undefined ? fs.constants.O_WRONLY : fs.constants.O_RDONLY;
                const file = await fsAsync.open(target.path, accessFlag | (fs.constants.O_NOFOLLOW || 0));
                try {
                    await this.applyAttributes(file, attrs);
                } finally {
                    await file.close();
                }
                this.stream.status(requestID, STATUS.OK);
            });
        });

        stream.on("MKDIR", (requestID, directory, attrs) => {
            this.run(requestID, async () => {
                const target = await this.resolvePath(directory, false);
                await fsAsync.mkdir(target.path, { mode: attrs.mode & 0o777 || 0o755 });
                this.stream.status(requestID, STATUS.OK);
            });
        });

        stream.on("RENAME", (requestID, oldPath, newPath) => {
            this.run(requestID, async () => {
                const source = await this.resolvePath(oldPath, false);
                const destination = await this.resolvePath(newPath, false);
                if (source.mount.physicalPath !== destination.mount.physicalPath) {
                    throw new Error("Moving files between mounted folders is not allowed");
                }
                await fsAsync.rename(source.path, destination.path);
                this.stream.status(requestID, STATUS.OK);
            });
        });

        stream.on("READLINK", (requestID) => {
            this.stream.status(requestID, STATUS.OP_UNSUPPORTED);
        });

        stream.on("SYMLINK", (requestID) => {
            this.stream.status(requestID, STATUS.OP_UNSUPPORTED);
        });

        stream.on("close", () => {
            for (const entry of this.handles.values()) {
                if (entry.type === "file") {
                    entry.handle.close().catch((error) => {
                        log.warn("sftp", `Failed to close file handle: ${error.message}`);
                    });
                }
            }
            this.handles.clear();
        });
    }

    private async run(requestID: number, action: () => Promise<void>) {
        try {
            await action();
        } catch (error) {
            this.stream.status(requestID, errorStatus(error));
        }
    }

    private getFileHandle(handle: Buffer): FileHandleEntry {
        const entry = this.handles.get(handle.toString("hex"));
        if (!entry || entry.type !== "file") {
            throw new Error("Invalid SFTP file handle");
        }
        return entry;
    }

    private getDirectoryHandle(handle: Buffer): DirectoryHandleEntry {
        const entry = this.handles.get(handle.toString("hex"));
        if (!entry || entry.type !== "directory") {
            throw new Error("Invalid SFTP directory handle");
        }
        return entry;
    }

    private getMountForPath(virtualPath: string): SftpMount | undefined {
        return this.mounts
            .filter((item) => virtualPath === item.virtualPath || virtualPath.startsWith(`${item.virtualPath}/`))
            .sort((left, right) => right.virtualPath.length - left.virtualPath.length)[0];
    }

    private async applyAttributes(handle: FileHandle, attrs: Attributes) {
        if (attrs.size !== undefined) {
            await handle.truncate(attrs.size);
        }
        if (attrs.mode !== undefined) {
            await handle.chmod(attrs.mode & 0o777);
        }
        if (attrs.atime !== undefined || attrs.mtime !== undefined) {
            const stat = await handle.stat();
            const atime = attrs.atime ?? Math.floor(stat.atimeMs / 1000);
            const mtime = attrs.mtime ?? Math.floor(stat.mtimeMs / 1000);
            await handle.utimes(atime, mtime);
        }
    }

    private isMountPath(virtualPath: string): boolean {
        return this.mounts.some((mount) => virtualPath === mount.virtualPath || virtualPath.startsWith(`${mount.virtualPath}/`));
    }

    private isVirtualDirectory(virtualPath: string): boolean {
        return virtualPath === "/" || this.mounts.some((mount) =>
            mount.virtualPath === virtualPath || mount.virtualPath.startsWith(`${virtualPath}/`));
    }

    private async readDirectory(virtualPath: string): Promise<FileEntry[]> {
        if (this.isVirtualDirectory(virtualPath) && !this.isMountPath(virtualPath)) {
            const prefix = virtualPath === "/" ? "/" : `${virtualPath}/`;
            const names = new Set<string>();
            for (const mount of this.mounts) {
                if (!mount.virtualPath.startsWith(prefix)) {
                    continue;
                }
                const remainder = mount.virtualPath.slice(prefix.length);
                names.add(remainder.split("/")[0]);
            }
            return Array.from(names).sort().map((filename) => ({
                filename,
                longname: `drwxr-xr-x 1 dockge dockge 0 ${new Date().toDateString()} ${filename}`,
                attrs: virtualDirectoryAttributes(),
            }));
        }

        const directory = (await this.resolvePath(virtualPath, true)).path;
        const names = await fsAsync.readdir(directory);
        const entries: FileEntry[] = [];
        for (const filename of names) {
            try {
                const stat = await fsAsync.lstat(path.join(directory, filename));
                const entry: FileEntry = {
                    filename,
                    longname: "",
                    attrs: toAttributes(stat),
                };
                entry.longname = formatLongName(entry);
                entries.push(entry);
            } catch (error) {
                log.warn("sftp", `Unable to inspect ${path.join(directory, filename)}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return entries;
    }

    private async resolvePath(input: string, followFinal: boolean, allowMissing = false): Promise<{ path: string; mount: SftpMount }> {
        const virtualPath = normalizeVirtualPath(input);
        const mount = this.getMountForPath(virtualPath);
        if (!mount) {
            throw new Error("Path is outside the available folders");
        }

        const relative = path.posix.relative(mount.virtualPath, virtualPath);
        const target = path.resolve(mount.physicalPath, relative);
        if (!isWithin(mount.physicalPath, target)) {
            throw new Error("Path is outside the available folders");
        }

        if (followFinal) {
            try {
                const actualPath = await fsAsync.realpath(target);
                if (!isWithin(mount.physicalPath, actualPath)) {
                    throw new Error("Symbolic links outside the mounted folder are not allowed");
                }
                return { path: actualPath,
                    mount };
            } catch (error) {
                if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
            }
        }

        const parentPath = await fsAsync.realpath(path.dirname(target));
        if (!isWithin(mount.physicalPath, parentPath)) {
            throw new Error("Path is outside the available folders");
        }
        return { path: target,
            mount };
    }
}

export class SftpServer {
    readonly port: number;
    private server?: SSHServerType;
    private authenticatedClients = new Map<number, Set<{ end: () => void }>>();
    private clients = new Set<{ end: () => void }>();

    constructor(private dockgeServer: DockgeServer) {
        const port = Number(process.env.DOCKGE_SFTP_PORT ?? DEFAULT_SFTP_PORT);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error("DOCKGE_SFTP_PORT must be an integer between 1 and 65535");
        }
        this.port = port;
    }

    async start(): Promise<void> {
        const privateKeyPath = path.join(this.dockgeServer.config.dataDir, "sftp_host_key");
        let privateKey: string;
        if (fs.existsSync(privateKeyPath)) {
            privateKey = await fsAsync.readFile(privateKeyPath, "utf-8");
        } else {
            const generated = utils.generateKeyPairSync("ed25519");
            privateKey = generated.private;
            await fsAsync.writeFile(privateKeyPath, privateKey, { mode: 0o600,
                flag: "wx" });
        }
        await fsAsync.chmod(privateKeyPath, 0o600);

        const sshServer = new SSHServer({ hostKeys: [ privateKey ] }, (client) => {
            let authenticatedUserID: number | undefined;
            const clientState = { end: () => client.end() };
            this.clients.add(clientState);
            client.on("authentication", async (context) => {
                try {
                    if (context.method !== "password") {
                        context.reject([ "password" ]);
                        return;
                    }
                    const passwordContext = context as PasswordAuthContext;
                    const remaining = await sftpLoginRateLimiter.removeTokens();
                    if (remaining < 0) {
                        log.info("sftp", `Rate-limited SFTP authentication for user ${passwordContext.username}`);
                        passwordContext.reject();
                        return;
                    }

                    const user = await R.findOne(
                        "user",
                        "username = ? AND active = 1",
                        [ passwordContext.username ]
                    );
                    if (user && Number(user.twofa_status) !== 1 && verifyPassword(passwordContext.password, user.password)) {
                        authenticatedUserID = Number(user.id);
                        const connections = this.authenticatedClients.get(authenticatedUserID) ?? new Set();
                        connections.add(clientState);
                        this.authenticatedClients.set(authenticatedUserID, connections);
                        passwordContext.accept();
                    } else {
                        if (user && Number(user.twofa_status) === 1) {
                            log.info("sftp", `SFTP password login is unavailable for account ${passwordContext.username} because two-factor authentication is enabled`);
                        }
                        log.info("sftp", `Rejected SFTP login for user ${passwordContext.username}`);
                        passwordContext.reject();
                    }
                } catch (error) {
                    log.error("sftp", `SFTP authentication failed: ${error instanceof Error ? error.message : String(error)}`);
                    context.reject();
                }
            });

            client.on("session", (accept, reject) => {
                const session = accept();
                session.on("sftp", (acceptSftp, rejectSftp) => {
                    if (!authenticatedUserID) {
                        rejectSftp();
                        return;
                    }
                    void this.getUserMounts(authenticatedUserID)
                        .then((mounts) => {
                            new SftpFilesystem(acceptSftp(), mounts);
                        })
                        .catch((error: unknown) => {
                            log.error("sftp", `Failed to load folders for user ${authenticatedUserID}: ${error instanceof Error ? error.message : String(error)}`);
                            rejectSftp();
                        });
                });
                session.on("shell", (_accept, rejectShell) => rejectShell());
                session.on("exec", (_accept, rejectExec) => rejectExec());
            });
            client.on("tcpip", (_accept, rejectTcpip) => rejectTcpip());
            client.on("openssh.streamlocal", (_accept, rejectStreamlocal) => rejectStreamlocal());

            client.on("close", () => {
                this.clients.delete(clientState);
                if (authenticatedUserID !== undefined) {
                    const connections = this.authenticatedClients.get(authenticatedUserID);
                    connections?.delete(clientState);
                    if (connections?.size === 0) {
                        this.authenticatedClients.delete(authenticatedUserID);
                    }
                }
            });
            client.on("error", (error) => {
                log.warn("sftp", `SSH connection error: ${error.message}`);
            });
        });

        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => {
                sshServer.removeListener("listening", onListening);
                reject(error);
            };
            const onListening = () => {
                sshServer.removeListener("error", onError);
                resolve();
            };
            sshServer.once("error", onError);
            sshServer.once("listening", onListening);
            sshServer.on("error", (error: Error) => {
                log.error("sftp", `SFTP server error: ${error.message}`);
            });
            sshServer.listen(this.port, "0.0.0.0");
        });
        this.server = sshServer;
        log.info("sftp", `SFTP server listening on port ${this.port}`);
    }

    async stop(): Promise<void> {
        for (const client of this.clients) {
            client.end();
        }
        this.clients.clear();
        this.authenticatedClients.clear();
        if (this.server) {
            await new Promise<void>((resolve, reject) => {
                this.server?.close((error) => error ? reject(error) : resolve());
            });
            this.server = undefined;
        }
    }

    disconnectUser(userID: number): void {
        const connections = this.authenticatedClients.get(userID);
        if (!connections) {
            return;
        }
        for (const client of connections) {
            client.end();
        }
        this.authenticatedClients.delete(userID);
    }

    async getUserDirectories(userID: number): Promise<string[]> {
        const mounts = await this.getUserMounts(userID);
        return mounts.map((mount) => mount.virtualPath);
    }

    private async getUserMounts(userID: number): Promise<SftpMount[]> {
        const user = await R.findOne("user", "id = ? AND active = 1", [ userID ]);
        if (!user) {
            throw new Error("User account is not active");
        }

        const stackNames = user.role === "admin"
            ? await this.getLocalStackNames()
            : (await R.getAll(
                "SELECT stack_name FROM stack_owner WHERE user_id = ? AND endpoint = '' ORDER BY stack_name",
                [ userID ]
            ) as { stack_name: string }[]).map((row) => row.stack_name);
        const stacksRoot = await fsAsync.realpath(this.dockgeServer.stacksDir);
        const mounts: SftpMount[] = [];
        const seenVirtualPaths = new Set<string>();

        for (const stackName of stackNames) {
            if (!/^[a-zA-Z0-9_.-]+$/.test(stackName) || stackName === "." || stackName === "..") {
                continue;
            }
            try {
                if (!await Stack.composeFileExists(this.dockgeServer.stacksDir, stackName)) {
                    continue;
                }
                const stack = await Stack.getStack(this.dockgeServer, stackName);
                const stackPath = path.resolve(stack.fullPath);
                const stackRoot = await fsAsync.realpath(stack.fullPath);
                if (stackRoot !== path.join(stacksRoot, stackName)) {
                    log.warn("sftp", `Ignoring stack directory that is not its own canonical folder: ${stackName}`);
                    continue;
                }

                const args = [ "compose" ];
                if (fs.existsSync(path.join(this.dockgeServer.stacksDir, "global.env"))) {
                    args.push("--env-file", "../global.env");
                    if (fs.existsSync(path.join(stack.path, ".env"))) {
                        args.push("--env-file", "./.env");
                    }
                }
                args.push("config", "--format", "json");
                const result = await childProcessAsync.spawn("docker", args, {
                    cwd: stack.path,
                    encoding: "utf-8",
                });
                const config = JSON.parse(result.stdout?.toString() ?? "") as ComposeConfig;
                for (const [ serviceName, service ] of Object.entries(config.services ?? {})) {
                    for (const volume of service.volumes ?? []) {
                        if (volume.type !== "bind" || typeof volume.source !== "string" || typeof volume.target !== "string") {
                            continue;
                        }
                        const configuredSourcePath = path.resolve(volume.source);
                        const physicalPath = await fsAsync.realpath(configuredSourcePath);
                        const stat = await fsAsync.stat(physicalPath);
                        if (!stat.isDirectory() || physicalPath === path.parse(physicalPath).root) {
                            continue;
                        }
                        if (isWithin(stackPath, configuredSourcePath) && !isWithin(stackRoot, physicalPath)) {
                            log.warn("sftp", `Ignoring a bind mount that resolves outside its owned stack: ${configuredSourcePath}`);
                            continue;
                        }
                        if (!isWithin(stackRoot, physicalPath) || physicalPath === stackRoot) {
                            log.warn("sftp", `Ignoring a bind mount outside its owned stack directory: ${physicalPath}`);
                            continue;
                        }

                        const targetParts = volume.target.split("/").filter(Boolean);
                        if (targetParts.includes(".") || targetParts.includes("..")) {
                            log.warn("sftp", `Ignoring a bind mount with an invalid container target in stack ${stackName}`);
                            continue;
                        }
                        let servicePath = encodeURIComponent(serviceName);
                        if (servicePath === "." || servicePath === "..") {
                            servicePath = servicePath.replace(/\./g, "%2E");
                        }
                        const virtualPath = path.posix.join(
                            "/",
                            stackName,
                            servicePath,
                            ...targetParts
                        );
                        if (seenVirtualPaths.has(virtualPath)) {
                            log.warn("sftp", `Ignoring duplicate SFTP folder path ${virtualPath}`);
                            continue;
                        }
                        seenVirtualPaths.add(virtualPath);
                        mounts.push({ virtualPath,
                            physicalPath });
                    }
                }
            } catch (error) {
                log.warn("sftp", `Unable to load bind mounts for stack ${stackName}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return mounts;
    }

    private async getLocalStackNames(): Promise<string[]> {
        const entries = await fsAsync.readdir(this.dockgeServer.stacksDir, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    }
}
