FROM node:20-slim

# Install sqlite3 native compilation build tools if needed
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency declarations
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Create required runtime directories
RUN mkdir -p uploads temp logs .baileys_auth

# Hugging Face Spaces default port
EXPOSE 7860
ENV PORT=7860
ENV AUTH_DIR=/app/.baileys_auth

# Start the application
CMD ["npm", "start"]
