import { describe, expect, it } from "vitest";
import { findBuiltInMic, isBluetoothMicLabel, stripPseudoDevicePrefix } from "../voiceMicDevices";

describe("isBluetoothMicLabel", () => {
  it.each([
    "Greg's AirPods Pro",
    "AirPods Pro (Bluetooth)",
    "Headset (AirPods Pro Hands-Free AG Audio)",
    "Headset (WH-1000XM4 Hands-Free)",
    "Pixel Buds Pro (HSP/HFP)",
    "bluez_input.AA_BB_CC",
    "Beats Studio Buds",
  ])("treats %s as Bluetooth", (label) => {
    expect(isBluetoothMicLabel(label)).toBe(true);
  });

  it.each([
    "MacBook Pro Microphone",
    "MacBook Pro Microphone (Built-in)",
    "Microphone Array (Realtek(R) Audio)",
    "Headset Microphone (Realtek(R) Audio)",
    "Blue Yeti (046d:0ab1)",
    "Built-in Audio Analog Stereo",
    "",
  ])("does not treat %s as Bluetooth", (label) => {
    expect(isBluetoothMicLabel(label)).toBe(false);
  });

  it("is false without a label", () => {
    expect(isBluetoothMicLabel(null)).toBe(false);
    expect(isBluetoothMicLabel(undefined)).toBe(false);
  });
});

describe("stripPseudoDevicePrefix", () => {
  it("drops Chromium's default and communications prefixes", () => {
    expect(stripPseudoDevicePrefix("Default - MacBook Pro Microphone")).toBe(
      "MacBook Pro Microphone"
    );
    expect(stripPseudoDevicePrefix("Communications - Microphone Array (Realtek)")).toBe(
      "Microphone Array (Realtek)"
    );
    expect(stripPseudoDevicePrefix("AirPods Pro")).toBe("AirPods Pro");
  });
});

describe("findBuiltInMic", () => {
  it("picks the Mac's own microphone over a Bluetooth one and the default alias", () => {
    expect(
      findBuiltInMic([
        { deviceId: "default", label: "Default - MacBook Pro Microphone" },
        { deviceId: "airpods", label: "Greg's AirPods Pro" },
        { deviceId: "builtin", label: "MacBook Pro Microphone" },
      ])
    ).toEqual({ deviceId: "builtin", label: "MacBook Pro Microphone" });
  });

  it("reads a transport suffix when the label carries one", () => {
    expect(
      findBuiltInMic([
        { deviceId: "airpods", label: "AirPods Pro (Bluetooth)" },
        { deviceId: "builtin", label: "Mac Studio Microphone (Built-in)" },
      ])
    ).toEqual({ deviceId: "builtin", label: "Mac Studio Microphone (Built-in)" });
  });

  it("prefers the Mac's own mic over its headphone-jack input", () => {
    const jack = { deviceId: "jack", label: "External Microphone (Built-in)" };
    const mac = { deviceId: "mac", label: "MacBook Air Microphone (Built-in)" };
    expect(findBuiltInMic([jack, mac])).toEqual(mac);
    expect(findBuiltInMic([jack])).toBeNull();
  });

  it("never offers a Bluetooth device, whatever else its name says", () => {
    const btArray = { deviceId: "bt", label: "Microphone Array (Bluetooth)" };
    const builtIn = { deviceId: "builtin", label: "Internal Microphone" };
    expect(findBuiltInMic([btArray])).toBeNull();
    expect(findBuiltInMic([btArray, builtIn])).toEqual(builtIn);
  });

  it("takes a Windows array mic only when it is the one array and isn't external", () => {
    const array = { deviceId: "array", label: "Microphone Array (Realtek(R) Audio)" };
    const usbArray = { deviceId: "usb", label: "Microphone Array (USB Audio Device)" };
    const internal = { deviceId: "internal", label: "Internal Microphone" };
    expect(
      findBuiltInMic([array, { deviceId: "bt", label: "Headset (Hands-Free AG Audio)" }])
    ).toEqual(array);
    expect(findBuiltInMic([array, internal])).toEqual(internal);
    expect(findBuiltInMic([usbArray])).toBeNull();
    expect(
      findBuiltInMic([array, { deviceId: "array2", label: "Microphone Array (Intel SST)" }])
    ).toBeNull();
  });

  it("returns null when no device can be told apart as built in", () => {
    expect(
      findBuiltInMic([
        { deviceId: "default", label: "Default - MacBook Pro Microphone" },
        { deviceId: "yeti", label: "Blue Yeti" },
        { deviceId: "", label: "" },
      ])
    ).toBeNull();
  });
});
