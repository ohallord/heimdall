import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@electric-sql/pglite", "pg", "nodemailer", "bcryptjs"],
  experimental: {
    // Docker builds on some hosts die with "Error: kill EACCES" while Next tears down its
    // build child processes (seccomp/AppArmor/userns). Worker threads need no process kill;
    // capping the pool also keeps memory sane on many-core build hosts.
    workerThreads: true,
    cpus: 4,
  },
};

export default nextConfig;
