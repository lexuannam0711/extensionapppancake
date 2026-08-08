# Windows 7 legacy build

The main package uses Electron 34 for modern Windows versions. Windows 7 is
supported only by the separate Electron 22 legacy ZIP because Electron 23 and
newer no longer support Windows 7/8/8.1.

Build the portable archive on a supported build machine:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-win7.ps1
```

The output is:

```text
dist\PancakeDesktopAIShortcutBot-<version>-Win7-x64.zip
```

The archive includes its Electron runtime and does not require Node.js or npm
on the Windows 7 machine. Copy `.env.example` to `.env` and enter local
configuration after extracting it. Never put `.env`, API keys, or saved user
data into the archive.

Electron 22 is the final Electron major version with Windows 7 support and is
legacy software. Upgrade the operating system when possible.
