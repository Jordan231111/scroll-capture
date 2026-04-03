export default {
  sourceDir: ".",
  artifactsDir: "./dist",
  ignoreFiles: [
    "package.json",
    "package-lock.json",
    "node_modules",
    "dist",
    "README.md",
    "web-ext-config.mjs",
    ".git",
    ".gitignore",
    ".webextignore",
    ".DS_Store",
  ],
  build: {
    overwriteDest: true,
  },
};
