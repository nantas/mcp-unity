# MCP Unity Development And Snapshot Installation

This fork supports two local installation modes for Unity projects without relying on Unity Package Manager dependency declarations.

## Why this workflow

- `mcp-unity` is optional per project member.
- The package should not force shared `manifest.json` changes on the whole team.
- Development needs a tight edit-test loop against a real host Unity project.
- Personal installs should stay outside version control for the host project.

## Installation modes

### Development mode: symlink the source repository

Use this when you are actively changing the package and need immediate feedback in a host Unity project.

Command:

```bash
./scripts/link-package-to-project.sh /ABSOLUTE/PATH/TO/UnityProject
```

What it does:

- creates `Packages/com.gamelovers.mcp-unity` as a symlink to this repository
- updates the host project's `.gitignore` with:

```gitignore
/Packages/com.gamelovers.mcp-unity
```

- leaves `Packages/manifest.json` untouched

Recommended Node workflow during development:

```bash
cd Server~
npm install
npm run watch
```

Recommended validation flow:

1. Open the host Unity project after linking the package.
2. Confirm Unity recompiles the package without errors.
3. Start the MCP Unity server from the Unity Editor window.
4. Run MCP requests from one or more client sessions against the host project.
5. Verify behavior in the real Unity project, not only in this source repository.

### Release mode: copy a package snapshot into the Unity project

Use this when development is done and you want a personal local install in a Unity project without keeping a live link to the source repository.

Command:

```bash
./scripts/install-package-snapshot.sh /ABSOLUTE/PATH/TO/UnityProject
```

Prerequisite:

```bash
cd Server~
npm install
npm run build
```

What it does:

- copies a clean snapshot into `Packages/com.gamelovers.mcp-unity`
- excludes repo-only and heavy transient content such as `.git`, `scripts/`, `docs/plans/`, and `Server~/node_modules/`
- updates the host project's `.gitignore` with:

```gitignore
/Packages/com.gamelovers.mcp-unity
```

- keeps installation local to the user and outside the host project's shared dependency configuration

## Why not Package Manager for this fork

Using `Add package from git URL...` writes package dependency state into the host project's `Packages/manifest.json`. That is useful for shared team-managed dependencies, but it conflicts with this fork's goal:

- each developer may choose whether to install `mcp-unity`
- the package should not alter shared package policy for the whole Unity project
- local development should target a real host project through a live source checkout

For this fork, the recommended install location is always:

```text
<UnityProject>/Packages/com.gamelovers.mcp-unity
```

The only difference between the two modes is whether that path is a symlink or a copied snapshot.

## Host project gitignore policy

Add this to the host Unity project's `.gitignore`:

```gitignore
/Packages/com.gamelovers.mcp-unity
```

That keeps both the development symlink and the copied release snapshot local to the individual developer.

## Current validation limitation

This repository is a Unity package repository, not a standalone Unity project. That means some Unity Editor integration tests still need to be validated inside a real host Unity project after linking or installing the package.
