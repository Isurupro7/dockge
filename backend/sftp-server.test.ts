import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ssh2 from "ssh2";
import type { Client as SSHClient, Server as SSHServerType, SFTPWrapper } from "ssh2";
import { SftpFilesystem } from "./sftp-server";
import type { SftpMount } from "./sftp-server";

const { Client, Server: SSHServer, utils } = ssh2;

function connectSftp(port: number): Promise<{ client: SSHClient; sftp: SFTPWrapper }> {
    return new Promise((resolve, reject) => {
        const client = new Client();
        client.on("error", reject);
        client.on("ready", () => {
            client.sftp((error, sftp) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve({ client,
                    sftp });
            });
        });
        client.connect({
            host: "127.0.0.1",
            port,
            username: "sftp-test",
            password: "sftp-test-password",
            readyTimeout: 5000,
        });
    });
}

function writeRemoteFile(sftp: SFTPWrapper, remotePath: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.writeFile(remotePath, content, (error) => error ? reject(error) : resolve());
    });
}

function readRemoteFile(sftp: SFTPWrapper, remotePath: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        sftp.readFile(remotePath, (error, data) => error ? reject(error) : resolve(data));
    });
}

function listRemoteDirectory(sftp: SFTPWrapper, remotePath: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        sftp.readdir(remotePath, (error, entries) => error ? reject(error) : resolve(entries.map((entry) => entry.filename)));
    });
}

function statRemotePath(sftp: SFTPWrapper, remotePath: string): Promise<{ isDirectory(): boolean }> {
    return new Promise((resolve, reject) => {
        sftp.stat(remotePath, (error, stats) => error ? reject(error) : resolve(stats));
    });
}

function renameRemoteFile(sftp: SFTPWrapper, source: string, destination: string): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.rename(source, destination, (error) => error ? reject(error) : resolve());
    });
}

function removeRemoteDirectory(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.rmdir(remotePath, (error) => error ? reject(error) : resolve());
    });
}

function waitForListening(server: SSHServerType): Promise<number> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error) => {
            server.removeListener("listening", onListening);
            reject(error);
        };
        const onListening = () => {
            server.removeListener("error", onError);
            const address = server.address();
            if (!address || typeof address === "string") {
                reject(new Error("The test SFTP server did not bind to a TCP port"));
                return;
            }
            resolve(address.port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, "127.0.0.1");
    });
}

test("SFTP exposes only mounted paths and supports file transfers", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-sftp-test-"));
    const mountPath = path.join(tempDir, "mounted");
    const outsidePath = path.join(tempDir, "outside.txt");
    await fs.mkdir(mountPath);
    await fs.writeFile(outsidePath, "outside the mount");
    await fs.symlink(outsidePath, path.join(mountPath, "outside-link"));

    const mounts: SftpMount[] = [{
        virtualPath: "/stack/web/data",
        physicalPath: mountPath,
    }];
    const server = new SSHServer({ hostKeys: [ utils.generateKeyPairSync("ed25519").private ] }, (client) => {
        client.on("authentication", (context) => {
            if (context.method === "password" && context.username === "sftp-test" && context.password === "sftp-test-password") {
                context.accept();
            } else {
                context.reject([ "password" ]);
            }
        });
        client.on("session", (accept) => {
            const session = accept();
            session.on("sftp", (acceptSftp) => {
                new SftpFilesystem(acceptSftp(), mounts);
            });
        });
    });

    let client: SSHClient | undefined;
    try {
        const port = await waitForListening(server);
        const connection = await connectSftp(port);
        client = connection.client;
        assert.deepEqual(await listRemoteDirectory(connection.sftp, "/"), [ "stack" ]);
        assert.equal((await statRemotePath(connection.sftp, "/stack/web/data")).isDirectory(), true);
        await writeRemoteFile(connection.sftp, "/stack/web/data/uploaded.txt", "SFTP works");
        assert.equal((await fs.readFile(path.join(mountPath, "uploaded.txt"), "utf-8")), "SFTP works");
        assert.equal((await readRemoteFile(connection.sftp, "/stack/web/data/uploaded.txt")).toString(), "SFTP works");
        await renameRemoteFile(
            connection.sftp,
            "/stack/web/data/uploaded.txt",
            "/stack/web/data/renamed.txt"
        );
        assert.equal((await fs.readFile(path.join(mountPath, "renamed.txt"), "utf-8")), "SFTP works");
        assert.equal(
            (await readRemoteFile(connection.sftp, "/stack/web/data/../data/renamed.txt")).toString(),
            "SFTP works"
        );
        await assert.rejects(removeRemoteDirectory(connection.sftp, "/stack/web/data"));
        await assert.rejects(readRemoteFile(connection.sftp, "/stack/web/data/../../outside.txt"));
        await assert.rejects(readRemoteFile(connection.sftp, "/stack/web/data/outside-link"));
    } finally {
        client?.end();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await fs.rm(tempDir, { recursive: true,
            force: true });
    }
});
