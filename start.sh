#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

APP_NAME="nuxt-python-app"
COMPOSE_PROJECT="test"

echo ""
echo -e "${CYAN}=========================================="
echo "  Nuxt 4 + Python User Management System"
echo -e "==========================================${NC}"
echo ""

# --- Step 0: Check Docker ---
if ! command -v docker &> /dev/null || ! docker compose version &> /dev/null 2>&1; then
    echo -e "${RED}Error: Docker or Docker Compose not found. Please install Docker first.${NC}"
    exit 1
fi

# --- Step 1: Pull latest code from remote ---
echo -e "${YELLOW}>>> [1/3] Syncing code from remote...${NC}"
CURRENT_BRANCH=$(git branch --show-current)

if git remote get-url origin &> /dev/null; then
    # Fetch with retry
    RETRIES=0
    until git fetch origin "$CURRENT_BRANCH" 2>/dev/null || [ $RETRIES -ge 4 ]; do
        RETRIES=$((RETRIES + 1))
        WAIT=$((2 ** RETRIES))
        echo -e "${YELLOW}  Fetch failed, retrying in ${WAIT}s... (${RETRIES}/4)${NC}"
        sleep $WAIT
    done

    # Check if there are upstream changes
    LOCAL=$(git rev-parse HEAD 2>/dev/null)
    REMOTE=$(git rev-parse "origin/$CURRENT_BRANCH" 2>/dev/null || echo "")

    if [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
        echo -e "${GREEN}  New commits found, pulling...${NC}"
        git pull origin "$CURRENT_BRANCH" --ff-only || {
            echo -e "${YELLOW}  Fast-forward failed. Please resolve conflicts manually.${NC}"
            exit 1
        }
        echo -e "${GREEN}  Code updated!${NC}"
    else
        echo -e "${GREEN}  Already up to date.${NC}"
    fi
else
    echo -e "${YELLOW}  No remote configured, skipping sync.${NC}"
fi

# --- Step 2: Smart build ---
echo ""
echo -e "${YELLOW}>>> [2/3] Preparing Docker containers...${NC}"

NEED_BUILD=false

# Check if image exists
IMAGE_ID=$(docker compose images -q 2>/dev/null || echo "")
if [ -z "$IMAGE_ID" ]; then
    echo -e "${CYAN}  No image found, will build...${NC}"
    NEED_BUILD=true
fi

# Check if dependency files changed since last build (compare with image creation time)
if [ "$NEED_BUILD" = false ]; then
    # Get image creation timestamp
    IMAGE_TIME=$(docker inspect --format='{{.Created}}' "$IMAGE_ID" 2>/dev/null | head -1)
    IMAGE_EPOCH=$(date -d "$IMAGE_TIME" +%s 2>/dev/null || echo "0")

    # Check if Dockerfile, requirements.txt, or package.json changed after image was built
    for f in Dockerfile backend/requirements.txt frontend/package.json; do
        if [ -f "$f" ]; then
            FILE_EPOCH=$(stat -c %Y "$f" 2>/dev/null || echo "0")
            if [ "$FILE_EPOCH" -gt "$IMAGE_EPOCH" ]; then
                echo -e "${CYAN}  $f changed since last build, will rebuild...${NC}"
                NEED_BUILD=true
                break
            fi
        fi
    done
fi

if [ "$NEED_BUILD" = true ]; then
    echo -e "${YELLOW}  Building image...${NC}"
    docker compose build
else
    echo -e "${GREEN}  Image is up to date, skipping build.${NC}"
fi

# --- Step 3: Start containers ---
echo ""
echo -e "${YELLOW}>>> [3/3] Starting services...${NC}"

# Start in detached mode first to show status, then attach for logs
docker compose up -d

echo ""
echo -e "${CYAN}=========================================="
echo -e "${GREEN}  Services are running!${NC}"
echo ""
echo -e "  App:       ${CYAN}http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):5001${NC}"
echo -e "  API Docs:  ${CYAN}http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):5001/api/docs${NC}"
echo ""
echo "  Admin: admin / admin123"
echo ""
echo -e "  ${YELLOW}Hot reload is ON${NC} — edit code, see changes instantly"
echo -e "  Press Ctrl+C to stop"
echo -e "${CYAN}==========================================${NC}"
echo ""

# Attach to logs (Ctrl+C will stop following, containers keep running)
# Use trap to also stop containers on exit
trap 'echo ""; echo -e "${YELLOW}Stopping containers...${NC}"; docker compose down; exit 0' SIGINT SIGTERM

docker compose logs -f
