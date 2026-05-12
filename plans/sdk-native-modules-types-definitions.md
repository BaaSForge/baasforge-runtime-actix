We have shimmed nodejs native modules, as we can't cover all its modules so there are always modules which exists in nodejs but not in our runtime.
Therefore we need a typing module declaring native modules supported by our runtime, and remove the base `node` type from the unit typescript checker to let the LLM find out what module is not supported by us.

NOTE: It's better to do this plan after we got enough feedback from the LLM to add the missing native modules as much as we can, then we can do this, so we cover more modules til that day.