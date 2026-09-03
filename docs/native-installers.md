# Native installers

EffectGate builds four unsigned native package formats from the exact signed
`v1.0.2` npm tarball:

| Platform | Artifact | Install command |
|---|---|---|
| Windows x64 | `effectgate-preview-1.0.2-x64.msi` | `msiexec /i effectgate-preview-1.0.2-x64.msi` |
| macOS | `effectgate-preview-1.0.2-universal.pkg` | `sudo installer -pkg effectgate-preview-1.0.2-universal.pkg -target /` |
| Debian/Ubuntu | `effectgate-preview_1.0.2_all.deb` | `sudo apt install ./effectgate-preview_1.0.2_all.deb` |
| RPM Linux | `effectgate-preview-1.0.2-1.noarch.rpm` | `sudo dnf install ./effectgate-preview-1.0.2-1.noarch.rpm` |

All packages require Node.js 24 or newer. They contain the dependency-free
EffectGate package and a small launcher; installation does not run npm or
download application code.

## Qualification

The `Native installer qualification` workflow:

1. Downloads the published GitHub release tarball.
2. Requires SHA-256
   `9f8b288d4e2af47084cf8c4cf63d3a988b59ee7acb2b074b111a5537946a1e48`.
3. Rejects package identity, version, license, engine, entrypoint, and symlink
   mismatches before staging.
4. Builds packages with `dpkg-deb`, `rpmbuild`, `pkgbuild`, and pinned WiX
   Toolset 6.0.2.
5. Extracts or inspects every package and runs its contained CLI with
   `--version`.
6. Uploads each package with a SHA-256 checksum as a workflow artifact.

The workflow has read-only repository permission. The v1.0.2 installers are
attached to the GitHub release only after this qualification succeeded.

## Trust boundary

These packages are unsigned previews. Windows SmartScreen and macOS Gatekeeper
may warn before installation. Production signing or Apple notarization needs
separately controlled signing identities; no private signing key belongs in
the repository or GitHub Actions artifacts.

For the currently signed distribution path, install the npm tarball and verify
it as described in [Release engineering](releasing.md).
