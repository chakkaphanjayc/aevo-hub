import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  future: {
    v8_trailingSlashAwareDataRequests: true
  }
} satisfies Config;
