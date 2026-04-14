# Revising killers features document based on implemented units:

check the document @docs/0. killers-features.md and answer this questions:

we have developed workflow units just like Temporal and others, you can see it's test at @units/workflow-tests to figure out it's capabilities

now I want to plan adding new units, but I need to first make sure we don't create new units unless it helps users and brings new powers which can't be done by the current unit types we already have

so check the document and revise it

at the end of that document clearly tell what kind of units can help user and bring new capabilities, and also write some codes

IMPORTANT: your explanation is going to be used as revised version of @docs/0. killers-features.md so make sure you don't miss anything which is already in @docs/0. killers-features.md doc, that's our road map, and I just need to make sure it's chosen units carefully, thats it
























# Creating new units prompt:

take a look at @docs/killers-features.md 

I want to implement `Durable Workflow Unit` feature

first of all let met explain you about our platform (add these explanation into a doc at @docs too):

- We have a supabase-like platform, we call each function a `unit`, users can create multiple projects, each containing thousands of units, units are nodejs functions, which run in the current project (this project)
- Users can create different type of units we support, for now we just support `api` units which accepts a `req` and `res` and can answer and receive HTTP requests
- Users can trigger units either internally using our platform (using internal APIs we provide for them), or using the public API's unit's trigger URL, each api unit has a public trigger URL inside this project
- Units will be able to talk to each other through the sdk module we provide them in the nodejs runtime
- Units can access several tools & features which we listed in @docs/killers-features.md  later

Now here is what I want you:

0. The GOAL: I want you just to plan the implementation of `Durable Workflow Unit`, we have some explanation below which might refer other future goals, but you are going to design the plan of implementation of `Durable Workflow Unit`

0.0. I know there are open source or packages which are popular between developers to use `Durable workflow unit` in platforms like Supabase or firebase, I need you to check if there is any pre-built package or library instead of implementing it yourself, this way we make sure the SDK options you provide to the users are flexible enough as it's proven by community, THE ONLY thing you must consider is the runtime of that library must be ready to scale for using by millions of users, so the firs choice is to use an already exist project or library instead of implementing it, if there is nothing to use, you must to plan to use a high available infrastructure, note the SDK is very important, even if there is no high scale / proven runtime to use, the SDK must follow most popular tools or library matching our goal

SO you go by this priorities:

- if there is a proven library or package to run as a high scale runtime, use it instead of building the infrastrcuture yourself, in that case you must follow that tool or library to design the SDK features you provide to ther users
- if there is no proven runtime to use at scale, you must setup the infrastrucure in a dev runtime docker compose file, and wire the runtime to use for millions of projects
- in both cases you must support multi-tenancy so projects must be isolated and securely separated from other projects
- in both cases you must follow a proven tool or library to design the SDK to make sure: 1. users are familar with 2. its flexible enough and proven to implement complex goals

1. at @units folder we have already a folder which is a nodeJS project checking the core / language features we provide to the units, like importing from `node:*`, these are tested in that folder, the runtime (this project) also supports the `exact` same features (core / language features we listed in @units/runtime-check ) so the @units folder is going to be our source of truth of what is allowed to be written into the units codes (add this explanation to the docs too, its important)

2. we need to have a plan to write some tests for the `Durable workflow unit` we will introduce based on @docs/killers-features.md doc, so first we need to add some folder at @units specific to testing the feature we are going to add, there we list all features we support and write deep / detailed test for all, NOTE: IT'S very important to have detailed tests for that feature, whether inside a single file or multiple files, its just important to me to check all aspects of that feature we introduce as our SDK

3. then we need to support that feature in this project (the real runtime), I know we might need some servers (redis or something else you choose, so write a dev docker compose file (something like runtime-compose.yml) to run them locally, use password for each, then support those features one by one in the runtime

4. the sdk must be as convenient as it could be, I mean it doesn't need to be set up by the user, every tool must be initialized and managed internally by us, the sdk is just to use

5. we need a type declaration file for the sdk features written in typescript so we can type check the units codes againts it to make sure it's written correctly

NOTE: its important to give the sdk access to the tools I mentioned only scoped to their project so ther users' units can't access to other projects (neither their project nor other user's projects, projects are completely isolated), so when you write tests make sure you write the tests to check the isolation of each sdk tool, for the tests you can hard code the project uuids, for a real project's units the units all have a `project_id` like at @schema.rs (148-149) 

NOTE: all the available modules to import are listed into @units/runtime-check/index.ts , nothing else is allowed, so when you provide the new features, you MUST add those features under `@sdk`

NOTE: for the tools like kafka or redis or others which we want to provide to the units through the SDK, we need to provide the features supported by the real official sdk for that tool expect some limitations: 1. the tools are shared across multiple projects, so the users are not allowed to setup their own Kafka for example, they just use a SDK which is mimicing the official sdk of Kafka in nodejs 2. as we don't want to allow each user to configure the Kafka or other tools, we need to cut some SDK features as they are not allowed, for all tools I need you to carefully define what is SDK capable of doing while they use the same shared kafka instances scoped to their project

NOTE: some features like workflows or sagas or others may need to persist some state of their own, it's important to note that the runtime (current project) database must be separated from the dashboard platform project which user's see and define their units there, so if you need these kind of data to persist, just add a new service into dev docker compose file (something like runtime-compose.yml), note as these states must be very fast, you need to use a database or tool which has persistent while it can load the live data into the RAM so it would be fast enough, so it doesnt have to do anything with @src/schema.rs as its for the dashboard project

IMPORTANT: the tools and functions you define into SDK is very important to be chosen carefully as it allows the users to write their logics, it must be flexible enough, , make sure you consider the flexibility a lot to allow users combine the sdk features to build something powerful, try to follow proven sdks which are popular between developers

IMPORTANT: the features we introduce as the first platform supporting those (like saga or event sourcing or actors) must be designed very carefuly as they are one of the most promising features of our platform, so for each one follow the most popular frameworks to get idea to design their abilities and features, like Axon or Orleans or others

NOTE: the codes you see at @docs/killers-features.md are just samples, don't consider those as the base code, THEY ARE JUST SAMPLES, you define what is needed based on what I said in this message

IMPORTANT: when you choose what infrastrucute to use for these new features (like what to use to persist the event sourcing units or saga units), you MUST consider the multi-tenancy and security concerns too, we can't setup a single instance of tools like kafka or nats or a single separated database for each project, so you have to use tools which have these abilities buit-in and can support millions of projects
IMPORTANT: the different unit types must be able to communicate to eachother, so in the SDK provide proper solution to async or sync calls between different units, note we have some events in different unit types like sagas or event sourced units, Im not sure whether they must be shared and accessible between different unit types or they must be exclusive for those units only, you analyze and choose what to do

NOTE: we need to provide some monitoring tools for the users to see their unit's activities or tracing or logs, in your plan add a separated detailed plan for what to add to the dashboard platform, please write it exactly how it needs to be implemented and provide detailed technical instructions (like what must be the UI or how data are persisted and fetched and so on...)







