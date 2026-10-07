# plurnk-mimetypes-text-clojure

Read `../POSSUMTECH.md` completely before this file. Stop if that central
contract is unavailable. This file adds only rules specific to the
independently published `@plurnk/plurnk-mimetypes-text-clojure` package.

## Contract ownership

This repository owns one format-specific mimetype implementation: its source,
generated parser or grammar when present, tests, package metadata, and built
publication artifacts. It does not own the general mimetype framework.

The framework contract, handler interface, and package-discovery behavior are
owned by `../plurnk-service/plurnk-mimetypes/SPEC.md`. A change that applies
across handlers starts there and is then consumed here; do not add a parallel
framework mechanism in this package.

Declare compatibility through named peer dependency ranges and retain exact
installed versions as test evidence. This package versions independently under
SemVer; an unchanged compatible consumer does not release to match a framework
number. Preserve the independent package boundary and publication history.

## Development

Install the locked dependency graph and run the repository-owned gates:

```sh
npm ci
npm test
npm run build
```

The tracked pre-push hook runs `npm test` after the package lifecycle has
configured `.githooks`. Generated artifacts must come from the checked-in
build procedure; do not hand-edit them.

## Forge and release

PossumTech Gitea `origin` is the canonical development forge. The `github`
remote is the public downstream publication surface, and npm is the public
package registry. GitHub and npm changes are deliberate publication or
release operations from accepted Gitea state; do not routinely dual-push.
