FROM oven/bun:1.3-alpine

WORKDIR /app

# Copy package files first for caching
COPY package.json bun.lock* ./
RUN bun install --production

# Copy the rest of the source
COPY . .

# Run bun link to register the gbrain CLI binary
RUN bun link

# The PORT env var is set by Railway
ENV PORT=3131

# Expose the HTTP port
EXPOSE 3131

# Start the HTTP MCP server bound to 0.0.0.0
CMD ["bun", "run", "src/cli.ts", "serve", "--http", "--port", "3131", "--bind", "0.0.0.0"]
