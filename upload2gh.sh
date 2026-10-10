#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
#  upload2gh.sh — Upload a folder to GitHub (Termux + gh CLI)
# ============================================================

set -e

# ---------- Colors ----------
G='\033[0;32m'; R='\033[0;31m'; Y='\033[1;33m'; C='\033[0;36m'; N='\033[0m'

# ---------- Check deps ----------
command -v git >/dev/null 2>&1 || { echo -e "${R}git not installed. Run: pkg install git${N}"; exit 1; }
command -v gh  >/dev/null 2>&1 || { echo -e "${R}gh not installed. Run: pkg install gh${N}";  exit 1; }

# ---------- Check gh auth ----------
if ! gh auth status >/dev/null 2>&1; then
    echo -e "${Y}You are not logged into gh. Starting login...${N}"
    gh auth login
fi

# ---------- Inputs ----------
read -rp "$(echo -e "${C}Folder to upload (e.g. ./myproject): ${N}")" SRC
read -rp "$(echo -e "${C}Repo name on GitHub: ${N}")" REPO_NAME
read -rp "$(echo -e "${C}Visibility [public/private] (default public): ${N}")" VIS
VIS=${VIS:-public}
read -rp "$(echo -e "${C}Commit message (default 'Initial commit'): ${N}")" MSG
MSG=${MSG:-"Initial commit"}

# ---------- Validate source ----------
if [ ! -d "$SRC" ]; then
    echo -e "${R}Error: '$SRC' is not a directory.${N}"
    exit 1
fi

SRC=$(cd "$SRC" && pwd)   # absolute path
echo -e "${G}→ Source: $SRC${N}"

# ---------- If it's a zip, auto-extract ----------
if [[ "$SRC" == *.zip ]]; then
    echo -e "${Y}Extracting zip...${N}"
    unzip -q "$SRC"
    SRC="${SRC%.zip}"
fi

cd "$SRC"

# ---------- Init git repo ----------
if [ ! -d ".git" ]; then
    echo -e "${C}Initializing git repo...${N}"
    git init -q
    git branch -M main
fi

# ---------- Create .gitignore (if missing) ----------
if [ ! -f ".gitignore" ]; then
    cat > .gitignore <<'EOF'
# Termux / common junk
.DS_Store
Thumbs.db
*.log
*.tmp
__pycache__/
node_modules/
.venv/
env/
.env
EOF
    echo -e "${G}✓ Created default .gitignore${N}"
fi

# ---------- Set identity if missing ----------
if ! git config user.email >/dev/null; then
    GH_EMAIL=$(gh api user --jq .email 2>/dev/null || echo "you@example.com")
    GH_USER=$(gh api user --jq .login)
    git config user.name  "$GH_USER"
    git config user.email "$GH_EMAIL"
fi

# ---------- Stage & commit ----------
git add -A
if git diff --cached --quiet; then
    echo -e "${Y}Nothing new to commit.${N}"
else
    git commit -q -m "$MSG"
    echo -e "${G}✓ Committed${N}"
fi

# ---------- Create repo on GitHub (if not exist) ----------
GH_USER=$(gh api user --jq .login)
if gh repo view "$GH_USER/$REPO_NAME" >/dev/null 2>&1; then
    echo -e "${Y}Repo '$GH_USER/$REPO_NAME' already exists — will push into it.${N}"
else
    echo -e "${C}Creating GitHub repo '$REPO_NAME' ($VIS)...${N}"
    gh repo create "$REPO_NAME" --"$VIS" --source=. --remote=origin --push
fi

# ---------- Ensure remote ----------
REMOTE_URL="https://github.com/$GH_USER/$REPO_NAME.git"
if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$REMOTE_URL"
else
    git remote add origin "$REMOTE_URL"
fi

# ---------- Push ----------
echo -e "${C}Pushing to origin/main...${N}"
git push -u origin main

echo -e "${G}✅ Done! → https://github.com/$GH_USER/$REPO_NAME${N}"