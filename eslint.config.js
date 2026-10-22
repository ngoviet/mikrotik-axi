import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // .claude/: worktree của phiên agent chứa bản sao src/ ⇒ ESLint thấy 2 tsconfig root và vỡ.
  { ignores: ["dist/", "build/", "coverage/", "node_modules/", ".claude/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
);
