import { describe, expect, it } from "vitest";
import type { DiskMetric, MountMetric } from "@/lib/db/types";
import { filesystemRows } from "./mounts-display";

const disk = (mountPoint: string, usedPercent: number, fsType = "ext4"): DiskMetric => ({
  mountPoint,
  device: `/dev/${mountPoint.replace(/\W/g, "") || "root"}`,
  fsType,
  totalBytes: 100,
  usedBytes: usedPercent,
  freeBytes: 100 - usedPercent,
  usedPercent,
});

describe("filesystemRows", () => {
  it("lists discovered filesystems and only expected paths as missing", () => {
    const mounts: MountMetric[] = [
      { path: "/", present: true, usedPercent: 40 },
      { path: "/backup", present: false },
    ];
    const rows = filesystemRows(mounts, [disk("/", 40), disk("/media1", 70), disk("/boot/efi", 2, "vfat")]);
    expect(rows.map((r) => [r.path, r.present, r.expected])).toEqual([
      ["/backup", false, true],
      ["/", true, true],
      ["/media1", true, false],
      ["/boot/efi", true, false],
    ]);
    expect(rows.find((r) => r.path === "/media1")?.usedPercent).toBe(70);
    expect(rows.find((r) => r.path === "/boot/efi")?.fsType).toBe("vfat");
  });

  it("does not invent /var when it is only a directory on /", () => {
    const rows = filesystemRows([{ path: "/", present: true }], [disk("/", 40)]);
    expect(rows.map((r) => r.path)).toEqual(["/"]);
  });

  it("keeps an expected present mount without a disk sample", () => {
    const rows = filesystemRows(
      [{ path: "/data", present: true, fsType: "nfs4", usedPercent: 12 }],
      [],
    );
    expect(rows).toEqual([
      expect.objectContaining({ path: "/data", present: true, expected: true, usedPercent: 12, fsType: "nfs4" }),
    ]);
  });
});

describe("filesystemRowsFromJson / formatBytes", () => {
  it("tolerates bad JSON and formats sizes", async () => {
    const { filesystemRowsFromJson, formatBytes } = await import("./mounts-display");
    expect(filesystemRowsFromJson("not json", null)).toEqual([]);
    expect(filesystemRowsFromJson('[{"path":"/","present":false}]', "[]")[0].present).toBe(false);
    expect(formatBytes(11_899_952_078_848)).toBe("11.9 TB");
    expect(formatBytes(983_105_044_480)).toBe("983 GB");
    expect(formatBytes(undefined)).toBe("—");
  });
});
