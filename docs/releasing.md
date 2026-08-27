# Release engineering

EffectGate's release process is source-bound: a build is only "stable" when its
exact commit carries reproducible artifacts, Tier-1 qualification evidence, and
five-role Ed25519 sign-off. This document covers verifying a published release,
reproducing it, and cutting a new one.

> [!NOTE]
> The five roles for v1.0.0 were signed by a single maintainer. That provides
> supply-chain integrity — not separation of duties, and not independent
> review. See [`docs/review/v1.0.0.md`](review/v1.0.0.md).

## Verify a published release

Download `effectgate-preview-1.0.0.tgz` from the
[v1.0.0 release](https://github.com/Miniks040506/EffectGate/releases/tag/v1.0.0),
then verify its SHA-256 digest:

```text
44aa32776701e22d8dab8e76307ea9013fd528a39493a63419545a3aed4f9c20
```

On Windows use `Get-FileHash effectgate-preview-1.0.0.tgz -Algorithm SHA256`.
On Linux use `sha256sum effectgate-preview-1.0.0.tgz`; on macOS use
`shasum -a 256 effectgate-preview-1.0.0.tgz`. The release also publishes
`SHA256SUMS`, a CycloneDX SBOM, source-bound provenance, qualification evidence,
five Ed25519 approvals, their public keys, and the final sign-off evidence.

After verification, install the downloaded file with:

```powershell
npm install --global ./effectgate-preview-1.0.0.tgz
```

### What the package contains

The package contains only the runtime source, focused operating guide, and
Apache-2.0 license. Tests, qualification evidence, and design files are not
installed. Re-running the install command upgrades or reinstalls the CLI
without touching configuration or state stored outside the package directory.
The package defines no install or uninstall lifecycle scripts.

## Tier-1 qualification workflows

The manual `Tier 1 package qualification` workflow pins Node `24.14.0` and
qualifies Linux x64, Linux arm64, Windows x64, and macOS x64. GitHub's concrete
Linux runner images are Ubuntu 24.04 for x64 and arm64; this is runner evidence,
not an Ubuntu-only runtime restriction. Each cell runs the full suite, then
installs the pinned `0.17.0` package, upgrades to `1.0.0`, rolls back, and
upgrades again while proving external state remains unchanged. The workflow
uses `workflow_dispatch` only, so pushes do not start hosted runners
automatically.


## Reproduce and cut a release

Create a source-bound release bundle from a clean checkout with an output path
that does not already exist:

```powershell
npm --prefix .\poc run release:bundle -- --output .\release-candidate --source-commit FULL_40_CHARACTER_GIT_SHA
```

The offline command writes the exact npm tarball, a normalized dependency-free
CycloneDX SBOM, `provenance.json`, and `SHA256SUMS`. Independent builds on the
same source and Node/npm toolchain must produce byte-identical tarballs, SBOMs,
and provenance.

The manual `Tier 1 release reproducibility` workflow builds that bundle on
Linux x64, Linux arm64, Windows x64, and macOS arm64, re-hashes every output,
checks its source-bound provenance and checksum manifest, and retains a single
qualification report only when all four bundles are byte-identical. Like the
other Tier-1 workflows, it runs only after an explicit manual dispatch.

After all ten stable gates produce source-bound `pass` evidence, compile the
canonical RC manifest:

```powershell
npm --prefix .\poc run --silent release:candidate -- --input .\release-input.json > release-candidate.json
```

The manifest binds the exact package, SBOM, provenance and evidence digests.
Stable sign-off requires valid Ed25519 approvals for Product, Technical,
Security, QA and Release roles over that single candidate digest.

`release-input.json` contains `release_qualification`, a path to the canonical
four-platform qualification JSON, and `evidence`, one `{ "gate", "path" }`
entry for every stable gate. Paths are relative to the input file. Evidence
must be bounded canonical JSON from the same source commit with a `pass`
verdict; symlinks, duplicate files, unsafe names and claimed digests are not
accepted. EffectGate hashes the admitted file bytes itself.

Each release role creates its canonical approval, then the verifier emits the
final sign-off evidence:

```powershell
npm --prefix .\poc run --silent release:approve -- --candidate release-candidate.json --role product --signer-key-id product-key-1 --private-key product.pem --issued-at 2026-08-02T00:00:00.000Z > product.approval.json
npm --prefix .\poc run --silent release:signoff -- --candidate release-candidate.json --sign-off release-signoff-input.json > release-signoff.json
```

The sign-off input binds the candidate digest and exactly five entries with
`role`, `signer_key_id`, `public_key`, and `approval` paths. The CLI never
generates, copies or stores private keys; it writes approval data only.


## Uninstall and purge

Before uninstalling, print the exact package command, preserved paths, and
optional purge arguments:

```powershell
effectgate uninstall --config D:\path\to\effectgate.json
```

The default command is `npm uninstall --global effectgate-preview`; it removes
the CLI while preserving configuration, state, and skill sources. Optional
state deletion must happen before package removal: run `effectgate purge
--config FILE` to review the exact owned state path and receive confirmation
arguments, then rerun with the printed SHA-256 digest and `--yes`. Purge refuses
filesystem roots, overlapping configuration/skill paths, missing ownership
markers, and mismatched confirmations. It deletes state only.
