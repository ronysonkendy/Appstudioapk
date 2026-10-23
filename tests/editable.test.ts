import { describe, it, expect } from "vitest";
import { classify, sniffImage } from "../backend/src/services/editable";

describe("classify", () => {
  it("texto editable en assets y res/raw", () => {
    expect(classify("assets/config.json")).toMatchObject({ kind: "text", editable: true });
    expect(classify("res/raw/data.txt").editable).toBe(true);
  });
  it("imagen editable", () => {
    expect(classify("res/mipmap-hdpi/ic_launcher.png")).toMatchObject({ kind: "image", editable: true });
  });
  it("binarios no editables", () => {
    for (const f of ["AndroidManifest.xml", "classes.dex", "resources.arsc", "res/layout/a.xml", "res/drawable/b.9.png", "lib/arm64-v8a/x.so"])
      expect(classify(f).editable).toBe(false);
  });
});
describe("sniffImage", () => {
  it("detecta formatos", () => {
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(sniffImage(Buffer.from("hola"))).toBeNull();
  });
});
