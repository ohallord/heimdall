import { describe, expect, it } from "vitest";
import {
  groupUnifiEvents,
  parseUnifiEventMeta,
  type UnifiEventRow,
} from "./ingest";

function row(
  id: string,
  payload: Record<string, unknown>,
  message = "msg",
): UnifiEventRow {
  return {
    id,
    severity: "warning",
    message,
    payload_json: JSON.stringify({ source: "unifi", ...payload }),
    created_at: "2026-10-22T00:00:00.000Z",
  };
}

describe("groupUnifiEvents", () => {
  it("groups by category then device", () => {
    const grouped = groupUnifiEvents([
      row("1", {
        name: "Internet Disconnected",
        category: "Internet / WAN",
        device: "UDM-Pro",
      }),
      row("2", {
        name: "Internet Disconnected",
        category: "Internet / WAN",
        device: "UDM-Pro",
      }),
      row("3", {
        name: "Front porch motion",
        device: "74ACB99F4E24",
      }),
    ]);
    expect(grouped.map((g) => g.typeKey)).toEqual([
      "Front porch motion",
      "Internet / WAN",
    ]);
    const wan = grouped.find((g) => g.typeKey === "Internet / WAN")!;
    expect(wan.devices).toHaveLength(1);
    expect(wan.devices[0]!.deviceKey).toBe("UDM-Pro");
    expect(wan.devices[0]!.events).toHaveLength(2);
  });

  it("recovers device/category from legacy raw parameters", () => {
    const meta = parseUnifiEventMeta(
      JSON.stringify({
        source: "unifi",
        name: "Internet Disconnected",
        raw: {
          parameters: {
            UNIFIhost: "UDM-Pro",
            UNIFIcategory: "Internet",
            UNIFIsubCategory: "WAN",
          },
        },
      }),
    );
    expect(meta.device).toBe("UDM-Pro");
    expect(meta.category).toBe("Internet / WAN");
  });
});
