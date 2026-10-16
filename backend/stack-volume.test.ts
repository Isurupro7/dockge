import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareBindMountDirectories } from "./stack";

test("bind mount directories are created inside the stack before Compose starts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-bind-mount-test-"));
    const stackRoot = path.join(tempDir, "stack");
    const outsideRoot = path.join(tempDir, "outside");
    const externalPath = path.join(tempDir, "external");
    const disabledPath = path.join(stackRoot, "disabled");
    const escapedPath = path.join(stackRoot, "escape", "new-folder");

    await fs.mkdir(stackRoot);
    await fs.mkdir(outsideRoot);
    await fs.symlink(outsideRoot, path.join(stackRoot, "escape"));

    try {
        await prepareBindMountDirectories(stackRoot, [
            {
                type: "bind",
                source: path.join(stackRoot, "data", "nested"),
            },
            {
                type: "bind",
                source: externalPath,
            },
            {
                type: "bind",
                source: disabledPath,
                bind: {
                    create_host_path: false,
                },
            },
            {
                type: "bind",
                source: escapedPath,
            },
        ]);

        const createdStat = await fs.stat(path.join(stackRoot, "data", "nested"));
        assert.equal(createdStat.isDirectory(), true);
        assert.equal(createdStat.uid, process.getuid?.());
        assert.equal(createdStat.gid, process.getgid?.());
        await assert.rejects(fs.stat(externalPath), { code: "ENOENT" });
        await assert.rejects(fs.stat(disabledPath), { code: "ENOENT" });
        await assert.rejects(fs.stat(escapedPath), { code: "ENOENT" });
    } finally {
        await fs.rm(tempDir, {
            recursive: true,
            force: true,
        });
    }
});
