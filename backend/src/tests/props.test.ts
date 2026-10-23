import { describe, it, expect } from "vitest";
import {
  parseProps, setLabelInString, setYmlValue, removePermission, checkVersionCode, PropError,
} from "../backend/src/services/propsText";

const manifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.ej.app">
    <uses-permission android:name="android.permission.INTERNET"/>
    <uses-permission android:name="android.permission.CAMERA"/>
    <application android:label="@string/app_name"></application>
</manifest>`;
const yml = "versionInfo:\n  versionCode: '12'\n  versionName: 1.2.3\n";
const strings = '<resources><string name="app_name">Mi App</string></resources>';

describe("propsText", () => {
  it("lee nombre, versión y permisos", () => {
    const p = parseProps(manifest, yml, strings);
    expect(p).toMatchObject({ packageName: "com.ej.app", appName: "Mi App", versionCode: "12", versionName: "1.2.3" });
    expect(p.permissions).toEqual(["android.permission.INTERNET", "android.permission.CAMERA"]);
  });
  it("cambia el nombre escapando caracteres", () => {
    expect(setLabelInString(strings, "app_name", "A & B's")).toContain(">A &amp; B\\'s<");
  });
  it("cambia versionCode sin tocar otras líneas", () => {
    expect(setYmlValue(yml, "versionCode", "99")).toBe("versionInfo:\n  versionCode: '99'\n  versionName: 1.2.3\n");
  });
  it("quita un permiso", () => {
    const r = removePermission(manifest, "android.permission.CAMERA");
    expect(r.removed).toBe(1);
    expect(r.text).not.toContain("CAMERA");
  });
  it("valida el número de versión", () => {
    expect(() => checkVersionCode("abc")).toThrow(PropError);
  });
});
