FROM node:22-slim

WORKDIR /app

# 安装所有依赖（包括 devDependencies 用于构建）
COPY package.json package-lock.json* ./
RUN npm install

# 构建 TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# 移除 devDependencies
RUN npm prune --production

EXPOSE 3000

CMD ["node", "dist/index.js"]
