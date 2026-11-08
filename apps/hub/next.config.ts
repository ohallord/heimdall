import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/http-guard/security-headers";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: [
    "@electric-sql/pglite",
    "@modelcontextprotocol/sdk",
    "pg",
    "nodemailer",
    "bcryptjs",
  ],
  experimental: {
    // Docker builds on some hosts die with "Error: kill EACCES" while Next tears down its
    // build child processes (seccomp/AppArmor/userns). Worker threads need no process kill;
    // capping the pool also keeps memory sane on many-core build hosts.
    workerThreads: true,
    cpus: 4,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
};

export default nextConfig;
