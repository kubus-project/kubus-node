import { describe, expect, it } from 'vitest';
import os from 'node:os';
import { detectPrivateLanAddress, isContainerRuntime } from '../src/config/env.js';

function iface(partial: Partial<os.NetworkInterfaceInfo>): os.NetworkInterfaceInfo {
  return {
    address: '0.0.0.0',
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: null,
    ...partial,
  } as os.NetworkInterfaceInfo;
}

describe('detectPrivateLanAddress — a wildcard bind still has to advertise something reachable', () => {
  it('returns the private IPv4 a phone on the same network can reach', () => {
    const address = detectPrivateLanAddress({
      lo: [iface({ address: '127.0.0.1', internal: true })],
      eth0: [iface({ address: '192.168.1.42' })],
    });
    expect(address).toBe('192.168.1.42');
  });

  it('accepts each RFC1918 range', () => {
    expect(detectPrivateLanAddress({ a: [iface({ address: '10.0.0.5' })] })).toBe('10.0.0.5');
    expect(detectPrivateLanAddress({ a: [iface({ address: '172.16.3.9' })] })).toBe('172.16.3.9');
    expect(detectPrivateLanAddress({ a: [iface({ address: '192.168.0.2' })] })).toBe('192.168.0.2');
  });

  it('skips loopback and other internal interfaces', () => {
    expect(
      detectPrivateLanAddress({ lo: [iface({ address: '127.0.0.1', internal: true })] }),
    ).toBeUndefined();
  });

  it('skips public addresses — advertising one would be a QR that never connects', () => {
    expect(detectPrivateLanAddress({ eth0: [iface({ address: '8.8.8.8' })] })).toBeUndefined();
  });

  it('skips 172.x outside the private 16-31 block', () => {
    expect(detectPrivateLanAddress({ eth0: [iface({ address: '172.15.0.1' })] })).toBeUndefined();
    expect(detectPrivateLanAddress({ eth0: [iface({ address: '172.32.0.1' })] })).toBeUndefined();
  });

  it('skips IPv6, which the pairing URL builder does not advertise here', () => {
    expect(
      detectPrivateLanAddress({ eth0: [iface({ address: 'fd00::1', family: 'IPv6' })] }),
    ).toBeUndefined();
  });

  it('returns undefined when the host genuinely has no LAN address', () => {
    expect(detectPrivateLanAddress({})).toBeUndefined();
  });
});

describe('isContainerRuntime — auto-detection must not guess inside a container', () => {
  it('detects Docker', () => {
    expect(isContainerRuntime((path) => path === '/.dockerenv')).toBe(true);
  });

  it('detects Podman', () => {
    expect(isContainerRuntime((path) => path === '/run/.containerenv')).toBe(true);
  });

  it('is false on bare metal, where auto-detection is safe', () => {
    expect(isContainerRuntime(() => false)).toBe(false);
  });

  it('a container bridge address would otherwise look perfectly valid', () => {
    // This is exactly why the container guard exists: the address a container
    // reports for itself passes every private-range check, but the phone has
    // to reach the *host* instead, so advertising it yields a QR that scans
    // and then never connects.
    expect(detectPrivateLanAddress({ eth0: [iface({ address: '172.18.0.3' })] })).toBe(
      '172.18.0.3',
    );
  });
});
