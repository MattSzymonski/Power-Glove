#!/bin/bash

# REQUIREMENTS: npm, npx, git, an interactive shell
# DESCRIPTION: Prepares a Power Glove release and asks how to ship it.
#              Local mode   : bumps the version in package.json, builds the
#                            .vsix files on this machine, and leaves the
#                            version bump uncommitted.
#              Actions mode : bumps the version, commits the bump, creates
#                            a version tag, and pushes both to origin. The
#                            release workflow then builds the .vsix and
#                            attaches it to the GitHub release.
# USAGE: ./release_version.sh <version>
#
# EXAMPLE USAGE:
#   ./release_version.sh 1.1.0
#
# NOTES:
#   Run from the repository root directory.
#   The version must follow semver format (e.g. 1.0.0, 1.1.0).
#   Actions mode needs the .github/workflows files on the default branch
#   and no local tag with the same name yet.

# --- SCRIPT ---

set -euo pipefail

REQUESTED_VERSION="$1"
if [ -z "$REQUESTED_VERSION" ]; then
  echo "Usage: ./release_version.sh <version>"
  echo "Example: ./release_version.sh 1.1.0"
  exit 1
fi

# Reject anything that does not look like semver before changing files.
if ! echo "$REQUESTED_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-][0-9A-Za-z.-]+)?$'; then
  echo "Error: '$REQUESTED_VERSION' does not look like a semver version (e.g. 1.1.0)." >&2
  exit 1
fi

# Refuse a dirty working tree so the release commit in Actions mode only
# ever contains the version bump.
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: you have uncommitted changes. Please commit or stash them before releasing." >&2
  git status --short
  exit 1
fi

TAG_NAME="v$REQUESTED_VERSION"
REPO_URL=$(git remote get-url origin | sed 's/\.git$//' | sed 's|git@github.com:|https://github.com/|')

# Ask which delivery path to use.
echo ""
echo "Power Glove release $REQUESTED_VERSION"
echo "How do you want to ship it?"
echo "  1) Local build      bump the version and build the .vsix files here;"
echo "                      nothing is committed or pushed"
echo "  2) GitHub Actions   bump the version, commit it, tag v$REQUESTED_VERSION,"
echo "                      and push; CI builds the .vsix and attaches it to"
echo "                      the GitHub release"
echo "  3) Cancel"
RELEASE_MODE=""
while [ -z "$RELEASE_MODE" ]; do
  read -rp "Choice [1/2/3]: " MODE_CHOICE
  case "$MODE_CHOICE" in
    1) RELEASE_MODE="local" ;;
    2) RELEASE_MODE="actions" ;;
    3) echo "Cancelled."; exit 0 ;;
    *) echo "Please answer 1, 2, or 3." ;;
  esac
done

# The build steps below need the dev dependencies installed.
if [ ! -d "node_modules" ]; then
  echo "node_modules missing; running npm install..."
  npm install
fi

CURRENT_VERSION=$(node -p "require('./package.json').version")

# Bump the manifest version when it differs from the requested one.
if [ "$CURRENT_VERSION" = "$REQUESTED_VERSION" ]; then
  echo "package.json already at version $REQUESTED_VERSION."
else
  echo "Updating package.json version to $REQUESTED_VERSION..."
  npm version "$REQUESTED_VERSION" --no-git-tag-version
fi

if [ "$RELEASE_MODE" = "local" ]; then
  # Build the same two asset names the release workflow produces so the
  # local files can be side loaded or handed around the same way.
  echo "Building .vsix packages locally..."
  npx @vscode/vsce package --out "power-glove-$REQUESTED_VERSION.vsix"
  cp "power-glove-$REQUESTED_VERSION.vsix" "power-glove.vsix"

  echo ""
  echo "Local build finished."
  echo "Versioned asset: power-glove-$REQUESTED_VERSION.vsix"
  echo "Stable asset:    power-glove.vsix"
  echo ""
  echo "Install in VS Code:"
  echo "  code --install-extension power-glove-$REQUESTED_VERSION.vsix"
  echo "Install in code-server:"
  echo "  code-server --install-extension power-glove-$REQUESTED_VERSION.vsix"
  echo ""
  echo "The version bump is left uncommitted on purpose; commit it when ready."
  exit 0
fi

# Actions mode from here on.

# The CI release workflow requires the tag version and the package.json
# version to match, and it cannot overwrite an existing tag.
if git rev-parse "refs/tags/$TAG_NAME" >/dev/null 2>&1; then
  echo "Error: tag $TAG_NAME already exists. Pick a new version or delete the tag first." >&2
  exit 1
fi

# Last confirmation before anything is pushed to the remote.
read -rp "Push the commit and tag $TAG_NAME to origin? [y/N] " PUSH_CONFIRMATION
case "$PUSH_CONFIRMATION" in
  y|Y|yes|YES|Yes) ;;
  *) echo "Cancelled."; exit 0 ;;
esac

echo "Committing the version bump..."
git add package.json
if [ -f "package-lock.json" ]; then
  git add package-lock.json
fi
if git diff --cached --quiet; then
  echo "No changes to commit."
else
  git commit -m "Release $TAG_NAME"
fi

git tag "$TAG_NAME"

echo "Pushing the commit and the tag..."
git push
git push origin "$TAG_NAME"

echo ""
echo "Tag $TAG_NAME pushed. GitHub Actions is now building the .vsix and"
echo "attaching it to the GitHub release (release.yml)."
echo ""
echo "Track progress at:   $REPO_URL/actions"
echo "Release will appear: $REPO_URL/releases/tag/$TAG_NAME"
echo "Stable install link once CI finishes:"
echo "  $REPO_URL/releases/latest/download/power-glove.vsix"
