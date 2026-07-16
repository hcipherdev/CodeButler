import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Code Butler",
  description: "Local-first project memory for coding agents.",
  base: "/CodeButler/",
  cleanUrls: true,
  ignoreDeadLinks: [/\/architecture\.html/],
  themeConfig: {
    nav: [
      { text: "Quick Start", link: "/quickstart" },
      { text: "MCP Setup", link: "/mcp-setup" },
      { text: "Privacy", link: "/privacy" },
      { text: "Architecture", link: "/architecture.html" },
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
          { text: "Retrieval", link: "/retrieval" },
          { text: "Operations", link: "/operations" },
          { text: "Privacy", link: "/privacy" },
          { text: "Architecture", link: "/architecture.html" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/hcipherdev/CodeButler" },
    ],
  },
});
