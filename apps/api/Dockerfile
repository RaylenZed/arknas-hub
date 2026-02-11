FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN apk add --no-cache util-linux iproute2
RUN npm install --omit=dev
COPY src ./src

EXPOSE 8081
CMD ["npm", "start"]
