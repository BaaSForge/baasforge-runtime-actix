check the codes written at @workflow-runtime.js (1-353) and make sure it's not doing something which is not expected in platforms like Temporal, I mean the runtime code in the workflow units must not have the main / critical role in handling functionalities and everything must be safely persisted using our Rust runtime, because the js runtime might crash and we need to make sure the Rust runtime is handling every scenario correctly

we have written some tests which might give me the confidenc I need, check them first @units/workflow-tests/ there might be some tests which answers my questions and already gives us the confidence I need, if that's correct and tests are already giving that confidence, do nothing, if not, try to add some new tests if needed, and make sure the js runtime crash is handled in different scenarios

NOTE: I prefer to have tests for crash scenarios too, I mean for all possible scenarios like crash, so feel free to add new tests if you think increases the confidence

NOTE: the current tests are passing (63/63 tests for workflow)