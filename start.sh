#!/bin/bash
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${CYAN}=========================================="
echo "  Nuxt 4 + Python User Management System"
echo -e "==========================================${NC}"
echo ""

# --- Check Docker ---
if ! command -v docker &> /dev/null || ! docker compose version &> /dev/null 2>&1; then
    echo -e "${RED}Error: Docker or Docker Compose not found.${NC}"
    exit 1
fi

# --- Sync code from remote ---
CURRENT_BRANCH=$(git branch --show-current)
if git remote get-url origin &> /dev/null; then
    echo -e "${YELLOW}>>> Syncing code...${NC}"
    RETRIES=0
    until git fetch origin "$CURRENT_BRANCH" 2>/dev/null || [ $RETRIES -ge 4 ]; do
        RETRIES=$((RETRIES + 1))
        sleep $((2 ** RETRIES))
    done

    LOCAL=$(git rev-parse HEAD 2>/dev/null)
    REMOTE=$(git rev-parse "origin/$CURRENT_BRANCH" 2>/dev/null || echo "")

    if [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
        git pull origin "$CURRENT_BRANCH" --ff-only || {
            echo -e "${RED}  Merge conflict, please resolve manually.${NC}"
            exit 1
        }
        echo -e "${GREEN}  Code updated!${NC}"
    else
        echo -e "${GREEN}  Already up to date.${NC}"
    fi
fi

# --- Check if container is already running ---
RUNNING=$(docker compose ps -q --status running 2>/dev/null || echo "")

if [ -n "$RUNNING" ]; then
    # Container already running, code synced, hot reload handles the rest
    IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
    echo ""
    echo -e "${GREEN}  Container is already running, code synced.${NC}"
    echo -e "${GREEN}  Hot reload will pick up changes automatically.${NC}"
    echo ""
    echo -e "  App:       ${CYAN}http://${IP}:5001${NC}"
    echo -e "  API Docs:  ${CYAN}http://${IP}:5001/api/docs${NC}"
    echo ""
else
    # First run: build and start
    echo ""
    echo -e "${YELLOW}>>> First run, building and starting containers...${NC}"
    docker compose up --build -d

    IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
    echo ""
    echo -e "${GREEN}  Containers started!${NC}"
    echo ""
    echo -e "  App:       ${CYAN}http://${IP}:5001${NC}"
    echo -e "  API Docs:  ${CYAN}http://${IP}:5001/api/docs${NC}"
    echo -e "  Admin:     admin / admin123"
    echo ""
    echo -e "  ${YELLOW}Hot reload is ON${NC} — edit code, changes apply instantly"
    echo -e "  Containers run in background, no need to run this again"
    echo -e "  Stop with: ${CYAN}docker compose down${NC}"
fi

echo -e "${CYAN}==========================================${NC}"
