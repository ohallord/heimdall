import { beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin } from "@/lib/db/store";
import {
  ensureClusterRecord,
  getActiveClusterId,
  listClusters,
  setActiveCluster,
} from "./store";

describe("clusters store", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  it("registers clusters and switches active cluster", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Multi Cluster Org",
      adminName: "Admin",
      email: "clusters@example.com",
      password: "CorrectHorse1",
    });

    const first = await ensureClusterRecord({
      orgId: org.id,
      clusterId: "default",
      name: "Default",
    });
    expect(first.is_active).toBe(true);
    expect(await getActiveClusterId(org.id)).toBe("default");

    await ensureClusterRecord({
      orgId: org.id,
      clusterId: "prod-east",
      name: "Prod East",
    });
    const listed = await listClusters(org.id);
    expect(listed).toHaveLength(2);

    const settings = await setActiveCluster(org.id, "prod-east");
    expect(settings.active_cluster_id).toBe("prod-east");

    const after = await listClusters(org.id);
    expect(after.find((c) => c.cluster_id === "prod-east")?.is_active).toBe(
      true,
    );
    expect(after.find((c) => c.cluster_id === "default")?.is_active).toBe(
      false,
    );
  });
});
