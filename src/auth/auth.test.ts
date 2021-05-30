import appFactory from "../appFactory";
import query, { MbQueryAgent } from "../test/query";
import { Express } from "express";
import { createUser } from "../service/UserService";
import { clearDatabase } from "../../dev/test/TestRepo";
import supertest from "supertest";
import { datasetLoader } from "../../dev/test/datasetLoader";
import mockSgMail from "@sendgrid/mail";
import { getUserByEmail, getUserById } from "../data/UserRepo";
import { v4 } from "uuid";

// disable emails
jest.mock("@sendgrid/mail", () => ({
  send: jest.fn().mockResolvedValue(undefined),
  setApiKey: jest.fn(),
}));

describe("Authentication", () => {
  let app: Express;
  let user: any;
  let newUser: any;
  let getAgent = (): MbQueryAgent => query(app);
  let login: Function;
  let login_goodParams: Function;
  let check: Function;
  let register: Function;
  let expectedUser: any;
  let submitAccountConfirmationToken: Function;

  beforeAll(async () => {
    await clearDatabase();
    app = appFactory();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  beforeEach(async () => {
    const data = await datasetLoader("simple");
    user = data.users[0];
    login = (email: string, password: string, agent?: MbQueryAgent): supertest.Test => {
      const _agent = agent || getAgent();

      return _agent.post("/auth/login", {
        email,
        password,
      });
    };

    login_goodParams = (agent?: MbQueryAgent) => {
      const _agent = agent || getAgent();
      return login(user.email, "password", _agent);
    };

    check = (agent?: MbQueryAgent) => {
      const _agent = agent || getAgent();
      return _agent.post("/auth/check");
    };

    register = (
      opts: { firstName: string; lastName: string; email: string; password: string },
      agent?: MbQueryAgent,
    ) => {
      const _agent = agent || getAgent();
      const { firstName, lastName, email, password } = opts;

      return _agent.post("/auth/register", {
        firstName,
        lastName,
        email,
        password,
      });
    };

    submitAccountConfirmationToken = (opts: { confirmationToken: string; email: string }, agent?: MbQueryAgent) => {
      const _agent = agent || getAgent();
      const { confirmationToken, email } = opts;
      return _agent.get("/auth/confirmAccount").query({ confirm: confirmationToken, email });
    };

    expectedUser = {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
    };

    newUser = { firstName: "New", lastName: "User", email: "new@user.com", password: "newpassword" };
  });

  describe("login", () => {
    describe("sunny cases", () => {
      it("can log in", async () => {
        const response = await login_goodParams().expect(200);
        expect(response.body).toMatchObject(expectedUser);
      });

      it("does not send back password or passwordHash", async () => {
        const response = await login_goodParams().expect(200);
        expect(response.body.password).toBeFalsy();
        expect(response.body.passwordHash).toBeFalsy();
      });

      it("accurately reports during /auth/check that a logged-out user is logged-out", async () => {
        return check().expect(401);
      });

      it("can successfully check its own sessions", async () => {
        const agent = getAgent();
        await login_goodParams(agent).expect(200);
        const response = await agent.post("/auth/check");
        expect(response.body).toMatchObject(expectedUser);
      });

      it("can perform a full login flow", async () => {
        const agent = getAgent();
        await agent.post("/auth/check").expect(401);
        const loginResponse = await login_goodParams(agent).expect(200);
        expect(loginResponse.body).toMatchObject(expectedUser);
        const checkResponse = await agent.post("/auth/check").expect(200);
        expect(checkResponse.body).toMatchObject(expectedUser);
        await agent.post("/auth/logout").expect(200);
        const checkResponseAfterLogout = await agent.post("/auth/check").expect(401);
        expect(checkResponseAfterLogout.body).toMatchObject({});
      });

      describe("registering a new user", () => {
        it("can register a new user", async () => {
          const registerResponse = await register({
            firstName: "New",
            lastName: "User",
            email: "new@user.com",
            password: "newpassword",
          });

          expect(registerResponse.statusCode).toBe(200);
          expect(registerResponse.body.id).toBeTruthy();
          expect(registerResponse.body.createdAt).toBeTruthy();
          expect(registerResponse.body.firstName).toBe(newUser.firstName);
          expect(registerResponse.body.lastName).toBe(newUser.lastName);
          expect(registerResponse.body.email).toBe(newUser.email);
          expect(registerResponse.body.password).toBeFalsy();
          expect(registerResponse.body.passwordHash).toBeFalsy();
          expect(mockSgMail.send).toHaveBeenCalledTimes(1);
        });

        it("Successfully sets a confirmation token in the db.", async () => {
          const response = await register({
            firstName: "New",
            lastName: "User",
            email: "new@user.com",
            password: "newpassword",
          });

          expect(response.statusCode).toBe(200);

          const dbUser = await getUserById(response.body.id);
          expect(dbUser.id).toBeTruthy();
        });

        it("Successfully sends an email with a password confirmation token.", async () => {
          const response = await register({
            firstName: "New",
            lastName: "User",
            email: "new@user.com",
            password: "newpassword",
          });

          expect(response.statusCode).toBe(200);

          // @ts-expect-error mock is not on the type
          const sentHtml = mockSgMail.send.mock.calls[0][0].html;
          const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}/i;
          const hasConfirmationToken = uuidRegex.test(sentHtml);

          expect(hasConfirmationToken).toBe(true);
        });

        it("accountConfirmation flag behaviour", async () => {
          const confirmationToken = "9123f99b-e69b-4816-8e27-536856162f26";
          const email = "new@user.com";
          const password = "password";

          // confirm the user doesnt exist in the db
          const userNotYetCreated = await getUserByEmail(email);
          expect(userNotYetCreated).toBeFalsy();

          // create the user
          await createUser({
            email,
            firstName: "new",
            lastName: "user",
            password,
            confirmationToken,
          });

          // check that the user exists in the db with the confirmationToken
          const createdUser = await getUserByEmail(email);
          expect(createdUser).toBeTruthy();
          expect(createdUser.confirmationTokenHash).toBeTruthy();

          // login with an agent and check to see if the response has the flag
          // this agent is only used in a couple of calls this test.
          const agent = getAgent();
          const loginResponse = await login(createdUser.email, password, agent);
          expect(loginResponse.statusCode).toBe(200);
          expect(loginResponse.body.accountConfirmationPending).toBeTruthy();

          // check that the "check" response returns a flag.
          const checkResponse1 = await check(agent);
          expect(checkResponse1.body.accountConfirmationPending).toBeTruthy();

          // confirm the confirmationToken and check the response
          const confirmationResponse = await submitAccountConfirmationToken({ confirmationToken, email });
          expect(confirmationResponse.statusCode).toBe(200);

          // check that the "check" response no longer returns a flag.
          const checkResponse2 = await check(agent);
          expect(checkResponse2.body.accountConfirmationPending).toBeTruthy();

          // check that the user no longer has a confirmationTokenHash
          const createdUser2 = await getUserByEmail(email);
          expect(createdUser2).toBeTruthy();
          expect(createdUser2.id).toEqual(createdUser.id);
          expect(createdUser2.confirmationTokenHash).toBeFalsy();

          // login with a new agent and check to confirm the flag is gone
          // this agent is only used in a couple of calls this test.
          const agent2 = getAgent();
          const loginResponse2 = await login(email, password, agent2).expect(200);
          expect(loginResponse2.body.accountConfirmationPending).toBeFalsy();

          // check that the "check" response on a new session no longer returns a flag.
          const checkResponse3 = await check(agent2);
          expect(checkResponse3.body.accountConfirmationPending).toBeFalsy();
        });

        it("Successfully confirms an account with a confirmationToken", async () => {
          const confirmationToken = "9123f99b-e69b-4816-8e27-536856162f26";
          const email = "new@user.com";

          // confirm the user doesnt exist in the db
          const userNotYetCreated = await getUserByEmail(email);
          expect(userNotYetCreated).toBeFalsy();

          // create the user
          await createUser({
            email,
            firstName: "new",
            lastName: "user",
            password: "password",
            confirmationToken,
          });

          // check that the user exists in the db with the confirmationToken
          const createdUser = await getUserByEmail(email);
          expect(createdUser).toBeTruthy();
          expect(createdUser.confirmationTokenHash).toBeTruthy();

          // confirm the confirmationToken and check the response
          const confirmationResponse = await submitAccountConfirmationToken({ confirmationToken, email });
          expect(confirmationResponse.statusCode).toBe(200);
          expect(confirmationResponse.body.email).toBe(email);

          // check that the user no longer has a confirmationTokenHash
          const createdUser2 = await getUserByEmail(email);
          expect(createdUser2).toBeTruthy();
          expect(createdUser2.id).toEqual(createdUser.id);
          expect(createdUser2.confirmationTokenHash).toBeFalsy();
        });
      });
    });

    describe("rainy cases", () => {
      it("can't log in with the wrong password", async () => {
        await login(user.email, "wrongpassword").expect(401);
      });
      it("can't log in with the wrong email", async () => {
        await login("wrongemail@test.com", user.password).expect(401);
      });
      it("can't log in with the wrong email and wrong password", async () => {
        await login("wrongemail@test.com", "wrongpassword").expect(401);
      });
      it("gets 401 when checking without logged in", async () => {
        const response = await check();
        expect(response.body).toEqual({});
      });

      describe("registration", () => {
        it("validates email", async () => {
          await register({ ...newUser, email: null }).expect(400);
          await register({ ...newUser, email: undefined }).expect(400);
          await register({ ...newUser, email: 0 }).expect(400);
          await register({ ...newUser, email: 1 }).expect(400);
          await register({ ...newUser, email: { email: "lol" } }).expect(400);
          await register({ ...newUser, email: {} }).expect(400);
          await register({ ...newUser, email: "bademail" }).expect(400);
          await register({ ...newUser, email: "bademail@" }).expect(400);
          await register({ ...newUser, email: "bademail.com" }).expect(400);
          await register({ ...newUser, email: "@bademail.com" }).expect(400);
          await register({ ...newUser, email: " @bademail.com" }).expect(400);
          await register({ ...newUser, email: "bademail@something" }).expect(400);
          await register({ ...newUser, email: " bademail@something" }).expect(400);
          await register({ ...newUser, email: "bademail@something " }).expect(400);
          await register({ ...newUser, email: "bademail " }).expect(400);
          await register({ ...newUser, email: "lol@bademail .com" }).expect(400);
          expect(mockSgMail.send).toHaveBeenCalledTimes(0);
        });

        it("requires a password of at least 8 characters in length.", async () => {
          await register({ ...newUser, password: undefined }).expect(400);
          await register({ ...newUser, password: null }).expect(400);
          await register({ ...newUser, password: {} }).expect(400);
          await register({ ...newUser, password: { password: "lol" } }).expect(400);
          await register({ ...newUser, password: { password: null } }).expect(400);
          await register({ ...newUser, password: "" }).expect(400);
          await register({ ...newUser, password: "t" }).expect(400);
          await register({ ...newUser, password: "to" }).expect(400);
          await register({ ...newUser, password: "too" }).expect(400);
          await register({ ...newUser, password: "toos" }).expect(400);
          await register({ ...newUser, password: "toosh" }).expect(400);
          await register({ ...newUser, password: "toosho" }).expect(400);
          await register({ ...newUser, password: "tooshor" }).expect(400);
          expect(mockSgMail.send).toHaveBeenCalledTimes(0);
          expect(await getUserByEmail(newUser.email)).toBeFalsy();
          await register({ ...newUser, password: "NOTshort" }).expect(200);
          expect(mockSgMail.send).toHaveBeenCalledTimes(1);
          expect(await getUserByEmail(newUser.email)).toBeTruthy();
        });

        it("requires a first name", async () => {
          await register({ ...newUser, firstName: undefined }).expect(400);
          await register({ ...newUser, firstName: null }).expect(400);
          await register({ ...newUser, firstName: {} }).expect(400);
          await register({ ...newUser, firstName: { firstName: "lol" } }).expect(400);
          await register({ ...newUser, firstName: { firstName: null } }).expect(400);
          await register({ ...newUser, firstName: "" }).expect(400);
          expect(mockSgMail.send).toHaveBeenCalledTimes(0);
        });
        it("requires a last name", async () => {
          await register({ ...newUser, lastName: undefined }).expect(400);
          await register({ ...newUser, lastName: null }).expect(400);
          await register({ ...newUser, lastName: {} }).expect(400);
          await register({ ...newUser, lastName: { lastName: "lol" } }).expect(400);
          await register({ ...newUser, lastName: { lastName: null } }).expect(400);
          await register({ ...newUser, lastName: "" }).expect(400);
          expect(mockSgMail.send).toHaveBeenCalledTimes(0);
        });

        it("account confirmation fails if confirmationToken not in query param.", async () => {
          const response = await submitAccountConfirmationToken({
            confirmationToken: undefined,
            email: "user@user.com",
          });
          expect(response.statusCode).toBe(400);
          expect(response.body.errors.length).toBe(1);
        });

        it("account confirmation fails if confirmationToken is not uuid", async () => {
          const response = await submitAccountConfirmationToken({
            confirmationToken: "not-uuid",
            email: "user@user.com",
          });
          expect(response.body.errors.length).toBe(1);
        });

        it("account confirmation requires an email in the query param.", async () => {
          const response = await submitAccountConfirmationToken({
            email: undefined,
            confirmationToken: v4(),
          });
          expect(response.statusCode).toBe(400);
          expect(response.body.errors.length).toBe(1);
        });

        it("account confirmation fails if email string is not email format.", async () => {
          const response = await submitAccountConfirmationToken({
            email: "not-email",
            confirmationToken: v4(),
          });
          expect(response.statusCode).toBe(400);
          expect(response.body.errors.length).toBe(1);
        });

        it("will not confirm an account that has no confirmationToken in the database", async () => {
          const confirmationToken = "9123f99b-e69b-4816-8e27-536856162f26";
          const email = "new@user.com";

          // confirm the user doesnt exist in the db
          const userNotYetCreated = await getUserByEmail(email);
          expect(userNotYetCreated).toBeFalsy();

          // create the user
          await createUser({
            email,
            firstName: "new",
            lastName: "user",
            password: "password",
            confirmationToken: undefined,
          });

          // check that the user exists in the db with the confirmationToken
          const createdUser = await getUserByEmail(email);
          expect(createdUser).toBeTruthy();
          expect(createdUser.confirmationTokenHash).toBeFalsy();

          // confirm the confirmationToken and check the response
          const confirmationResponse = await submitAccountConfirmationToken({ confirmationToken, email });
          expect(confirmationResponse.statusCode).toBe(401);

          // check that the user still has no confirmationTokenHash
          const createdUser2 = await getUserByEmail(email);
          expect(createdUser2).toBeTruthy();
          expect(createdUser2.confirmationTokenHash).toBeFalsy();
        });
        it("will not confirm an account that does not exist", async () => {
          const confirmationToken = "9123f99b-e69b-4816-8e27-536856162f26";
          const email = "new@user.com";

          // confirm the user doesnt exist in the db
          const userNotYetCreated = await getUserByEmail(email);
          expect(userNotYetCreated).toBeFalsy();

          // confirm the confirmationToken and check the response
          const confirmationResponse = await submitAccountConfirmationToken({ confirmationToken, email });
          expect(confirmationResponse.statusCode).toBe(401);

          // check that the user still does not exist
          const userNotYetCreated2 = await getUserByEmail(email);
          expect(userNotYetCreated2).toBeFalsy();
        });
      });
    });
  });
});
