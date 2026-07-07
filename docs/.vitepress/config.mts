import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Code Butler",
  description: "Local-first project memory for coding agents.",
  base: "/CodeButler/",
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Quick Start", link: "/quickstart" },
      { text: "MCP Setup", link: "/mcp-setup" },
      { text: "GitHub", link: "https://github.com/hcipherdev/CodeButler" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Overview", link: "/" },
          { text: "Quick Start", link: "/quickstart" },
          { text: "MCP Setup", link: "/mcp-setup" },
          { text: "Public Sync", link: "/public-sync" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/hcipherdev/CodeButler" },
    ],
  },
});
