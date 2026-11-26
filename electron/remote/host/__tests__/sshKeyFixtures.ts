/** Public halves of throwaway keys, with what `ssh-keygen -E sha256 -lf` printed for each. */
export const FIXTURE_KEYS = {
  ed25519: {
    line: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPNlMBNltlXWvGQq4WLJvZ5toVDbLa7HMOCMt8RGeKoL root@fixture",
    fingerprint: "SHA256:Jnfxmchts+uebgkvrLRN6+3DPXv86aJb6F6XdZR+Z+o",
  },
  ecdsa: {
    line: "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBP4FTs4Xyi4QWZBqYIakDVLnVUeoTprthZ/Q7NMpHQFdzbEbOGBTChZ+dyrs5z9+HPuVXB/3krs411fsnEgQ7Ow= root@fixture",
    fingerprint: "SHA256:jws4AR6YyFw7bpM5j9YtF5wllTW4w337LlMwAqXzark",
  },
  rsa: {
    line: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC2uMWR92XXKx+ZU5o18glC9qU2NkR87iL4fstwsvjf+ZZyoXpDRQoS+Ews2WG7yCwprVJa0IqUOIPeqHUjPl/f75zEbzoy/BV2J/S17UbSOVRHGp89JeNyDjjTnCNxRoi4J+F4+yEp18T49KGtKJR0XEleNALDeQ7/8qHkGE7pJalmkhti7QURIt5j74rOQfvNZMvbhdqcTJbuzb0MGRdS21GbOahB7glW00D757lAN7aZtHAzbYI1SHPFF7WEWPNaItMiXbNQpZfTAMFagdZbWR/Qfrxf+ioezLy5aBXVVBsi1MMmyR4Nmj98Hdu+Dr7S7wsiO89R6dO50PY6rC0H root@fixture",
    fingerprint: "SHA256:HSLMBbZ4Mvu8gOruAAByzAMS55BHIgN3cNDZ4//WAks",
  },
} as const;

/** Stands in for a private key: never a real one, and the reader must never open it. */
export const NOT_A_PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n";
