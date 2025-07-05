# Use the Node.js 20 base image
FROM node:20-bookworm

# Set the working directory inside the container
WORKDIR /usr/src/app

# Install system dependencies.
# By removing "--no-install-recommends", we let apt install all suggested
# packages, which is more robust for a complex system like TeX Live.
RUN apt-get update && apt-get install -y \
    pandoc \
    texlive-latex-base \
    texlive-fonts-recommended \
    texlive-latex-extra \
    texlive-fonts-extra \
    texlive-xetex \
    && mktexlsr \
    && rm -rf /var/lib/apt/lists/*

# Copy package configuration files
COPY package*.json ./

# Install Node.js production dependencies
RUN npm ci --omit=dev

# Copy the rest of the application code
COPY . .

# Tell Docker which port the app will run on
EXPOSE 5000

# Define the command to start the app
CMD [ "node", "server.mjs" ]