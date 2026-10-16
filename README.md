<div align="center" width="100%">
    <img src="./frontend/public/icon.svg" width="128" alt="" />
</div>

# Dockge

A fancy, easy-to-use and reactive self-hosted docker compose.yaml stack-oriented manager.

[![GitHub Repo stars](https://img.shields.io/github/stars/louislam/dockge?logo=github&style=flat)](https://github.com/louislam/dockge) [![Docker Pulls](https://img.shields.io/docker/pulls/louislam/dockge?logo=docker)](https://hub.docker.com/r/louislam/dockge/tags) [![Docker Image Version (latest semver)](https://img.shields.io/docker/v/louislam/dockge/latest?label=docker%20image%20ver.)](https://hub.docker.com/r/louislam/dockge/tags) [![GitHub last commit (branch)](https://img.shields.io/github/last-commit/louislam/dockge/master?logo=github)](https://github.com/louislam/dockge/commits/master/)

<img src="https://github.com/louislam/dockge/assets/1336778/26a583e1-ecb1-4a8d-aedf-76157d714ad7" width="900" alt="" />

View Video: https://youtu.be/AWAlOQeNpgU?t=48

## ⭐ Features

- 🧑‍💼 Manage your `compose.yaml` files
  - Create/Edit/Start/Stop/Restart/Delete
  - Update Docker Images
- ⌨️ Interactive Editor for `compose.yaml`
- 🦦 Interactive Web Terminal
- 🕷️ (1.4.0 🆕) Multiple agents support - You can manage multiple stacks from different Docker hosts in one single interface
- 👥 User accounts with per-user stack ownership and CPU/memory quotas
- 🏪 Convert `docker run ...` commands into `compose.yaml`
- 📙 File based structure - Dockge won't kidnap your compose files, they are stored on your drive as usual. You can interact with them using normal `docker compose` commands

<img src="https://github.com/louislam/dockge/assets/1336778/cc071864-592e-4909-b73a-343a57494002" width=300 />

- 🚄 Reactive - Everything is just responsive. Progress (Pull/Up/Down) and terminal output are in real-time
- 🐣 Easy-to-use & fancy UI - If you love Uptime Kuma's UI/UX, you will love this one too

![](https://github.com/louislam/dockge/assets/1336778/89fc1023-b069-42c0-a01c-918c495f1a6a)

## 🔧 How to Install

Requirements:
- [Docker](https://docs.docker.com/engine/install/) 20+ / Podman
- (Podman only) podman-docker (Debian: `apt install podman-docker`)
- OS:
  - Major Linux distros that can run Docker/Podman such as:
     - ✅ Ubuntu
     - ✅ Debian (Bullseye or newer)
     - ✅ Raspbian (Bullseye or newer)
     - ✅ CentOS
     - ✅ Fedora
     - ✅ ArchLinux
  - ❌ Debian/Raspbian Buster or lower is not supported
  - ❌ Windows (Will be supported later)
- Arch: armv7, arm64, amd64 (a.k.a x86_64)

### Basic

- Default Stacks Directory: `/opt/stacks`
- Default Port: 5001

```
# Create directories that store your stacks and stores Dockge's stack
mkdir -p /opt/stacks /opt/dockge
cd /opt/dockge

# Download the compose.yaml
curl https://raw.githubusercontent.com/louislam/dockge/master/compose.yaml --output compose.yaml

# Start the server
docker compose up -d

# If you are using docker-compose V1 or Podman
# docker-compose up -d
```

Dockge is now running on http://localhost:5001

## User accounts and resource quotas

The first account created during setup is the administrator. Administrators can create accounts and assign roles and CPU/memory quotas from **Settings → User accounts**. Regular users can have quotas; administrators are unrestricted. Existing stacks remain administrator-owned; stacks created by a regular user are visible and manageable only by that account. Remote agents, global settings, and the host console are administrator-only.

Users can connect to Dockge over SFTP with their Dockge username and password using clients such as WinSCP. In **Settings → SFTP access**, each user can see the connection port and the folders available to them. Access is read/write and limited to bind-mounted directories located inside their own local stack folders; named Docker volumes, host directories outside the stack, and remote-agent stacks are not exposed. Dockge creates missing in-stack bind-mount directories before starting a stack, so they are owned by the Dockge process and writable over SFTP without manual permission changes. Existing directories keep their current ownership and permissions. Accounts with two-factor authentication enabled cannot use this password-only SFTP endpoint.

The default SFTP port is `2222`. The supplied `compose.yaml` publishes this port automatically. If it is already in use, set `DOCKGE_SFTP_PORT` in the Dockge compose `.env` file to another free port and recreate the container. The SFTP host key is stored in `data/sftp_host_key`; keep it with the Dockge data when backing up or moving the installation. The published port is reachable on the host's network interfaces; use a firewall to limit who can connect.

To run the SFTP feature from this source checkout, build and select this checkout's image instead of pulling the upstream image:

```bash
npm ci
npm run build:frontend
docker build --target release -f docker/Dockerfile -t dockge-custom .
```

Set `DOCKGE_IMAGE=dockge-custom` in the Dockge compose `.env` file, then run `docker compose up -d --force-recreate`.

Quota values are maximum aggregate Compose limits per account, summed across saved stacks and their fixed `deploy.replicas` counts, whether or not a stack is currently running. A value of `0` means unlimited. When a CPU quota is set, every service in a user's stack must specify a fixed `deploy.resources.limits.cpus`; when a memory quota is set, every service must specify `deploy.resources.limits.memory`. Resource values that depend on Compose variable interpolation are not accepted for a limited resource. Compose `include`, `extends`, `scale`, and global deployment mode are not supported while a quota is active because their resource totals cannot be bounded from the stack file alone. For example:

```yaml
services:
  web:
    image: nginx
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 256M
```

These account permissions are intended for trusted collaborators, not hostile tenants. Dockge needs access to the Docker socket, and a user who can deploy Compose configurations may gain host-level access through privileged containers, host mounts, or other Docker features. CPU/memory quotas are enforced against the configured Compose limits; they are not a measure of live host usage or a substitute for OS/container isolation.

Deleting a user removes their ownership records but leaves their stack files in place; those stacks then become administrator-only.

### Advanced

If you want to store your stacks in another directory, you can generate your compose.yaml file by using the following URL with custom query strings.

```
# Download your compose.yaml
curl "https://dockge.kuma.pet/compose.yaml?port=5001&stacksPath=/opt/stacks" --output compose.yaml
```

- port=`5001`
- stacksPath=`/opt/stacks`

Also, once compose is generated/downloaded, add the `PUID` and `PGID` section below to your compose `environment:` section to set stack ownership, otherwise default is `root`

```
      # Both PUID and PGID must be set for it to do anything
      - PUID=1000 # Set the stack file/dir ownership to this user
      - PGID=1000 # Set the stack file/dir ownership to this group
```

Interactive compose.yaml generator is available on: 
https://dockge.kuma.pet

### -OR-
Copy and paste your compose from the following:

If you want to store your stacks in another directory, you can change the `DOCKGE_STACKS_DIR` environment variable and volumes.

compose:
```
services:
  dockge:
    image: ${DOCKGE_IMAGE:-louislam/dockge:1}
    restart: unless-stopped
    ports:
      # Host Port:Container Port
      - 5001:5001
      - ${DOCKGE_SFTP_PORT:-2222}:${DOCKGE_SFTP_PORT:-2222}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/app/data
        
      # If you want to use private registries, you need to share the auth file with Dockge:
      # - /root/.docker/:/root/.docker

      # Stacks Directory
      # Your stacks directory in the host (The paths inside container must be the same as the host)
      # ⚠️ If you did it wrong, your data could end up be written into a wrong path.
      # ✔️ CORRECT EXAMPLE: - /my-stacks:/my-stacks (Both paths match)
      # ❌ WRONG EXAMPLE: - /docker:/my-stacks (Both paths do not match)
      - /opt/stacks:/opt/stacks
    environment:
      # Tell Dockge where your stacks directory is
      - DOCKGE_STACKS_DIR=/opt/stacks
      - DOCKGE_SFTP_PORT=${DOCKGE_SFTP_PORT:-2222}
      # Both PUID and PGID must be set for it to do anything
      - PUID=1000 # Set the stack file/dir ownership to this user
      - PGID=1000 # Set the stack file/dir ownership to this group
```

## How to Update

```bash
cd /opt/dockge
docker compose pull && docker compose up -d
```

## Screenshots

![](https://github.com/louislam/dockge/assets/1336778/e7ff0222-af2e-405c-b533-4eab04791b40)


![](https://github.com/louislam/dockge/assets/1336778/7139e88c-77ed-4d45-96e3-00b66d36d871)

![](https://github.com/louislam/dockge/assets/1336778/f019944c-0e87-405b-a1b8-625b35de1eeb)

![](https://github.com/louislam/dockge/assets/1336778/a4478d23-b1c4-4991-8768-1a7cad3472e3)


## Motivations

- I have been using Portainer for some time, but for the stack management, I am sometimes not satisfied with it. For example, sometimes when I try to deploy a stack, the loading icon keeps spinning for a few minutes without progress. And sometimes error messages are not clear.
- Try to develop with ES Module + TypeScript

If you love this project, please consider giving it a ⭐.


## 🗣️ Community and Contribution

### Bug Report
https://github.com/louislam/dockge/issues

### Ask for Help / Discussions
https://github.com/louislam/dockge/discussions

### Translation
If you want to translate Dockge into your language, please read [Translation Guide](https://github.com/louislam/dockge/blob/master/frontend/src/lang/README.md)

### Create a Pull Request

Be sure to read the [guide](https://github.com/louislam/dockge/blob/master/CONTRIBUTING.md), as we don't accept all types of pull requests and don't want to waste your time.

## FAQ

#### "Dockge"?

"Dockge" is a coinage word which is created by myself. I originally hoped it sounds like `Dodge`, but apparently many people called it `Dockage`, it is also acceptable.

The naming idea came from Twitch emotes like `sadge`, `bedge` or `wokege`. They all end in `-ge`.

#### Can I manage a single container without `compose.yaml`?

The main objective of Dockge is to try to use the docker `compose.yaml` for everything. If you want to manage a single container, you can just use Portainer or Docker CLI.

#### Can I manage existing stacks?

Yes, you can. However, you need to move your compose file into the stacks directory:

1. Stop your stack
2. Move your compose file into `/opt/stacks/<stackName>/compose.yaml`
3. In Dockge, click the " Scan Stacks Folder" button in the top-right corner's dropdown menu
4. Now you should see your stack in the list

#### Is Dockge a Portainer replacement?

Yes or no. Portainer provides a lot of Docker features. While Dockge is currently only focusing on docker-compose with a better user interface and better user experience.

If you want to manage your container with docker-compose only, the answer may be yes.

If you still need to manage something like docker networks, single containers, the answer may be no.

#### Can I install both Dockge and Portainer?

Yes, you can.

## Others

Dockge is built on top of [Compose V2](https://docs.docker.com/compose/migrate/). `compose.yaml`  also known as `docker-compose.yml`.
