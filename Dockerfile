# Use the Node.js 24 LTS base image
FROM node:24-bookworm

# Set the working directory
WORKDIR /usr/src/app

# --- LAYER 1: System Dependencies ---
# These are installed first and will be cached. This layer is only rebuilt if
# this command changes, which should be almost never.
# We also add --no-install-recommends to keep the install smaller and clean up after.
RUN apt-get update && apt-get install -y --no-install-recommends \
    pandoc \
    texlive-latex-base \
    texlive-fonts-recommended \
    texlive-latex-extra \
    texlive-fonts-extra \
    texlive-xetex \
    lmodern \
    fonts-noto-cjk \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# --- LAYER 2: Node.js Dependencies ---
# Copy only the package manager files.
COPY package.json package-lock.json ./

# Install Node.js dependencies. This layer is only rebuilt if package.json or
# package-lock.json changes. Code changes will NOT trigger this 'npm ci'.
RUN npm ci --omit=dev

# --- LAYER 3: Application Code ---
# Copy the rest of your application code LAST.
# This is the layer that will be rebuilt on every code change. Because the
# expensive layers above are cached, this step will be very fast.
COPY . .

# Expose port (good practice)
EXPOSE 5000

# Define the command to start the worker
CMD [ "npm", "start" ]