# Aiden Capability SDK (private preview)

This private package freezes the versioned manifest, JSON input/output,
permission, effect, secret-slot, and process protocol contracts used by Aiden
capabilities. It contains no Aiden database, Job, approval, credential, or host
runtime implementation.

Executable capability code is accepted only by a host that can enforce its
declared boundary. Importing this package does not itself create a security
sandbox.
