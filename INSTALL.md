# Installation

Kdenlive MCP runs on Windows and Linux. Release archives contain the MCP server
and its Node dependencies. They intentionally do not redistribute Node,
Kdenlive, MLT, or FFmpeg in the first public release.

## Requirements

- Node.js 22 or newer.
- Kdenlive with MLT, or separate `melt`, `ffmpeg`, and `ffprobe` executables.
- Windows x64 or Linux x64. Other architectures are not release-tested yet.

The tested Windows setup is Kdenlive 26.04.2 installed in
`C:\Program Files\Kdenlive`. Linux CI tests the distribution against the Ubuntu
MLT and FFmpeg packages. See [runtime support](docs/runtime-support.md).

## Windows source install

Open PowerShell in a clone of the repository:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1 -AddToPath
```

The default install root is `%LOCALAPPDATA%\KdenliveMCP`. Re-run the command to
upgrade. Uninstall with:

```powershell
.\scripts\uninstall.ps1
```

## Linux source install

```sh
chmod +x scripts/install.sh scripts/uninstall.sh
./scripts/install.sh
```

The default install root is `~/.local/share/kdenlive-mcp`. Set
`KDENLIVE_MCP_INSTALL_DIR` to override it. Uninstall with
`./scripts/uninstall.sh`.

## Release archive install

Download the archive and matching `.sha256` file from GitHub Releases. Verify the
checksum, extract it, and run:

```powershell
.\kdenlive-mcp.cmd --doctor
```

or:

```sh
./kdenlive-mcp --doctor
```

The doctor output shows every discovered path, version, required MLT service,
and codec. Fix all failures before configuring a client.

## Runtime discovery

No Kdenlive path is normally required. Discovery checks, in order:

1. `MELT_PATH`, `FFMPEG_PATH`, and `FFPROBE_PATH`.
2. `KDENLIVE_ROOT` and `MLT_ROOT`.
3. Standard Windows system and per-user Kdenlive directories.
4. Linux `/usr`, `/usr/local`, `/opt/kdenlive`, and AppImage `APPDIR`.
5. `PATH`.

For a portable Kdenlive installation:

```powershell
$env:KDENLIVE_ROOT = 'D:\Apps\Kdenlive'
.\kdenlive-mcp.cmd --doctor
```

## MCP client configuration

Each stdio client needs an allowed root and a stable client ID. The server cannot
read media or create projects outside that root.

Codex project/global configuration example:

```toml
[mcp_servers.kdenlive]
command = "C:\\path\\to\\kdenlive-mcp.cmd"
args = ["--root", "C:\\Users\\you\\Videos", "--client-id", "codex"]
startup_timeout_sec = 30
tool_timeout_sec = 3600
```

The exact Codex documentation could not be fetched while preparing this release;
verify the config-file location against the Codex version you use. The server
entry itself is exercised through the standard MCP stdio protocol in CI.

Claude Desktop and Cursor examples are in [examples](examples). Their config-file
locations vary by client version, so use the client UI/documentation to locate
the MCP configuration and paste the corresponding `mcpServers` entry.

Generic MCP clients should launch:

```text
kdenlive-mcp --root <absolute-media-root> --client-id <stable-client-name>
```

For authenticated loopback HTTP, run `kdenlive-mcp --http --root <path>
--port 8765`. The token-file location is printed to stderr. Do not expose that
port through a proxy or bind it to a non-loopback interface.

## Data and removal

By default, durable state is stored under `<allowed-root>/.kdenlive-mcp` and each
project stores `project.json`, `state.sqlite`, managed media, and artifacts in its
own directory. Uninstall scripts remove the application only; they do not delete
projects, media, client configuration, or state.

Continue with the [first project tutorial](docs/tutorial.md) or
[troubleshooting](docs/troubleshooting.md).
