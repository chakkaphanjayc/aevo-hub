import type { Config } from "@react-router/dev/config";

export default {
  basename: "/modern",
  ssr: true,
  future: {
    unstable_enableNodeReadableStream: true
  }
} satisfies Config;
