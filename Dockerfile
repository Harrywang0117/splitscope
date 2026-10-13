# Built on the router from prebuilt artifacts (dist/), so no npm install happens there.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8686 \
    DATA_DIR=/app/data/cache \
    STATIC_DATA_DIR=/app/data \
    WEB_DIR=/app/web \
    HOST_FILES=/host \
    TIMEZONE=Asia/Shanghai
COPY dist/ /app/
EXPOSE 8686
CMD ["node", "--no-warnings", "server.mjs"]
