#ifndef MAC_PHYS_FOOTPRINT_DATALESS_POLICY_H_
#define MAC_PHYS_FOOTPRINT_DATALESS_POLICY_H_

#include <napi.h>

// Adds disableThreadPoolDatalessMaterialization to the addon's exports (#16361).
void RegisterDatalessPolicy(Napi::Env env, Napi::Object exports);

#endif  // MAC_PHYS_FOOTPRINT_DATALESS_POLICY_H_
