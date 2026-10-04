import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), "")
  const token =
    process.env.VITE_MAPBOX_TOKEN ||
    process.env.MAPBOX_TOKEN ||
    fileEnv.VITE_MAPBOX_TOKEN ||
    fileEnv.MAPBOX_TOKEN ||
    ""
  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_MAPBOX_TOKEN": JSON.stringify(token),
    },
    server: {
      proxy: {
        "/api": "http://127.0.0.1:3001",
      },
    },
  }
})
