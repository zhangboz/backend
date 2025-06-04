# Choose a base Node.js image (select a version compatible with your app)
# Using an LTS version like Node 20 or 18 is a good start.
# The 'slim' or 'alpine' variants are smaller but might require more manual dependency installation.
# The full Debian-based images (like 'node:20-bookworm') are easier for installing system packages.
FROM node:20-bookworm

# Set a working directory in the container
WORKDIR /usr/src/app

# --- Install Pandoc ---
# Update package lists and install Pandoc and any dependencies it might need (like texlive for PDF)
# If you ONLY need DOCX and not PDF, you can skip texlive-* packages.
# For PDF generation, texlive-latex-base, texlive-fonts-recommended, and texlive-latex-extra are common.
# xelatex (part of texlive-xetex) is good for Unicode in PDFs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    pandoc \
    # ---- For PDF Generation (Optional, but often needed with Pandoc for PDF) ----
    # texlive-latex-base \
    # texlive-fonts-recommended \
    # texlive-fonts-extra \
    # texlive-latex-extra \
    # texlive-xetex \ # For xelatex engine
    # ---- End PDF Packages ----
    # Clean up apt cache to reduce image size
    && rm -rf /var/lib/apt/lists/*

# Copy package.json and package-lock.json (or yarn.lock)
COPY package*.json ./

# Install Node.js dependencies
# If you use yarn, replace with 'RUN yarn install --frozen-lockfile'
RUN npm install --omit=dev
# Or for production only: RUN npm ci --omit=dev

# Copy the rest of your application code
COPY . .

# Expose the port your app runs on
EXPOSE 5000

# Define the command to run your application
# Adjust if your entry point is different or in a subdirectory
CMD [ "node", "server.mjs" ]
# Or if server.mjs is in backend/: CMD [ "node", "backend/server.mjs" ]