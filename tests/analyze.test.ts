import { describe, it, expect } from "vitest";
import { categorize } from "../backend/src/services/zipSafe";
import { parseBadging } from "../backend/src/services/analyze";

describe("categorize", () => {
  it("clasifica rutas", () => {
    expect(categorize("classes2.dex")).toBe("dex");
    expect(categorize("res/mipmap-hdpi/ic.png")).toBe("image");
    expect(categorize("lib/arm64-v8a/x.so")).toBe("native");
  });
});
describe("parseBadging", () => {
  it("extrae datos básicos", () => {
    const r = parseBadging("package: name='com.a.b' versionCode='3' versionName='1.2'\nsdkVersion:'21'\ntargetSdkVersion:'34'\napplication-label:'Mi App'\nuses-permission: name='android.permission.INTERNET'\n");
    expect(r).toMatchObject({ packageName: "com.a.b", versionCode: "3", minSdk: 21, targetSdk: 34, appLabel: "Mi App" });
  });
});
