FROM node:20-slim

# Install Python
RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Backend dependencies ---
COPY backend/requirements.txt /app/backend/requirements.txt
RUN python3 -m venv /app/backend/venv && \
    /app/backend/venv/bin/pip install --no-cache-dir -r /app/backend/requirements.txt

# --- Frontend dependencies ---
COPY frontend/package.json /app/frontend/package.json
RUN cd /app/frontend && npm install

# --- Copy source code ---
COPY backend /app/backend
COPY frontend /app/frontend
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 3000 8000

CMD ["/app/entrypoint.sh"]
