**English** · [繁體中文](licensing.zh-TW.md)
# Licensing

Entask is open-source software licensed under the **GNU Affero General Public
License, version 3.0 only** (SPDX: `AGPL-3.0-only`). The complete license text is
in the [`LICENSE`](../LICENSE) file at the repository root; if there is any
conflict between this page and the `LICENSE` file, the `LICENSE` file governs.

## What the AGPL means for self-hosting

- You may use, study, modify, and redistribute Entask under the terms of the AGPL.
- The AGPL's network clause (section 13) matters most for hosted deployments:
  **if you modify Entask and let other people interact with your modified version
  over a network, you must offer those users the Corresponding Source of your
  version.** Running an unmodified copy does not trigger this obligation, and
  neither does self-hosting for your own internal use.
- The official builds include a source-offer link on the login page and in the
  user menu that points to this repository. **Modified deployments must change
  that link to point at their own source** — see `docs/REBRANDING.md` (section 1,
  item 11). Leaving the upstream link on a modified deployment is not a cosmetic
  issue; it makes your source offer inaccurate.
- You must keep copyright and license notices intact when you redistribute
  (AGPL section 5), including the notices for bundled third-party components in
  [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md).

## Commercial licensing

For organizations that cannot or do not wish to comply with the AGPL-3.0 — for
example, proprietary integration, redistribution, or white-label deployment —
ZebroDev may offer a separate commercial license on a case-by-case basis.
Contact [contact@zebrodev.com](mailto:contact@zebrodev.com) to discuss options.
Commercial terms require a separate written agreement; nothing on this page is a
quote, a warranty, or an offer.

## Why there is no CLA

Entask does not accept external code contributions (see
[`CONTRIBUTING.md`](../CONTRIBUTING.md)). Because all code is written by the
project owner, no Contributor License Agreement machinery is needed, and
ZebroDev holds the rights required to offer alternative commercial terms.

## Trademarks and brand

The AGPL covers the code. It does not grant rights to the "Entask" name or the
project logo, and it does not imply endorsement of derivative works. Forks are
welcome to rebrand; `docs/REBRANDING.md` documents the intended white-label
points.

## Third-party components

Entask bundles third-party open-source components (NuGet packages, web
dependencies, and vendored source). Their notices and license texts are listed
in [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md).

## Copyright

Copyright (c) 2026 ZebroDev.
