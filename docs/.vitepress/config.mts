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
      { text: "Privacy", link: "/privacy" },
      { text: "Architecture", link: "/architecture" },
      { text: "GitHub", link: "https://github.com/hcipherdev/CodeButler" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Overview", link: "/" },
          { text: "Quick Start", link: "/quickstart" },
          { text: "MCP Setup", link: "/mcp-setup" },
          { text: "Retrieval", link: "/retrieval" },
          { text: "Published Retrieval", link: "/retrieval-qualification" },
          { text: "Global Rules", link: "/global-rules" },
          { text: "Operations", link: "/operations" },
          { text: "Privacy", link: "/privacy" },
          { text: "Architecture", link: "/architecture" },
        ],
      },
      {
        text: "Encrypted Sync",
        items: [
          { text: "Protocol", link: "/encrypted-sync-protocol" },
          { text: "Secrets Folder Sync", link: "/secrets-sync" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/hcipherdev/CodeButler" },
    ],
  },
});
