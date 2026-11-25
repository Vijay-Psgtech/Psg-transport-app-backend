# PSG Transport Management — API

Express 4 and MongoDB/Mongoose API for login, role-based access, user provisioning, and fleet vehicles.

## Run locally

1. Copy `.env.example` to `.env`:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Set `MONGO_URI` to your MongoDB connection string and set `CLIENT_URL` to the web client's origin. Generate two separate JWT secrets (each at least 32 characters) with this command, running it once for each secret:

   ```powershell
   node -p "require('node:crypto').randomBytes(48).toString('base64url')"
   ```

   Paste the two generated values into `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` in `.env`. Never use the same value for both keys or commit `.env`.

3. Install dependencies and run the backend checks:

   ```powershell
   npm install
   npm test
   ```

4. Start the API with `npm run dev` (watch mode) or `npm start`. The default address is `http://localhost:5000`. Verify it at `http://localhost:5000/api/health`.

The server validates `MONGO_URI`, `JWT_ACCESS_SECRET`, and `JWT_REFRESH_SECRET` before connecting. If one is missing, it reports all missing settings and points to `.env.example`; it intentionally has no insecure JWT-secret fallback. `REFRESH_COOKIE_SAME_SITE` accepts `strict`, `lax`, or `none`; use `none` only when the web app and API are cross-site and served over HTTPS.

For local testing only, run `npm run seed` to create demo accounts for the administrator, transport officer, drivers, and transport user. Each new account gets a generated temporary password, which is printed once and saved in the Git-ignored `.seed-credentials.json` file. Later seed runs preserve existing accounts and passwords. Set optional `DEMO_ACCOUNT_PASSWORD` in `.env` only when you need one shared local demo password; the seed command updates demo accounts to it and requires a password change at first sign-in. The seed command refuses to run when `NODE_ENV=production`.

The app signs in with each account's email address or phone number; it does not use a separate username field. Both clients generate and display temporary passwords when an authorized user creates an account.

## Roles

| Role | Read vehicles | Create/update/delete vehicles | Create user accounts |
| --- | --- | --- | --- |
| `admin` | Yes | Yes | Yes |
| `manager` | Yes | Yes | No |
| `operator` | Yes | No | No |

Administrators create manager and operator accounts through `POST /api/auth/users`; public sign-up is intentionally disabled.

## Account identity and sign-in

Every account must have a unique phone number. Email is optional and, when provided, must be unique. Users can sign in with either their email address or phone number and password; drivers can use their phone number.

Before deploying this change to an existing database, backfill a valid, unique phone number for every account. Normalize existing phone values by removing spaces and hyphens and resolve any resulting duplicates. Convert blank email values to missing fields, then replace the existing non-sparse email index so multiple accounts may omit email:

```javascript
db.users.updateMany({ email: { $in: ['', null] } }, { $unset: { email: '' } })
db.users.dropIndex('email_1')
db.users.createIndex({ email: 1 }, { unique: true, sparse: true })
db.users.createIndex({ phone: 1 }, { unique: true, sparse: true })
```

Run the index changes only after checking for duplicate phone numbers and duplicate non-empty email addresses. Do not start the application until the existing email index is replaced.

## API

Authenticated API calls use bearer access tokens. Browser clients, including Expo Web, keep the short-lived access token in memory and use an HTTP-only refresh cookie. The Expo native client sends `client: "native"` to login, refresh, logout, and password-change endpoints; the API returns a rotating refresh token in the response body for the app to store with platform secure storage. The API stores only a hash of each refresh token and atomically rotates it; logout and password changes revoke server-side sessions. Configure `CLIENT_URL` for the web frontend; native API requests are not browser CORS requests.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | Public | Sign in; sets the web refresh cookie or returns a native refresh token |
| `POST` | `/api/auth/refresh` | Public | Rotate the web cookie or native refresh token and issue a new access token |
| `GET` | `/api/auth/me` | Authenticated | Return the current user |
| `POST` | `/api/auth/logout` | Public | Revoke the current refresh session and clear the web refresh cookie |
| `POST` | `/api/auth/users` | Admin | Create an account |
| `GET` | `/api/vehicles` | Authenticated | List vehicles; optional `type` and `status` filters |
| `POST` | `/api/vehicles` | Admin, manager | Add a vehicle |
| `PATCH` | `/api/vehicles/:id` | Admin, manager | Update provided vehicle fields |
| `DELETE` | `/api/vehicles/:id` | Admin, manager | Remove a vehicle |
| `GET` | `/api/service-history` | Admin, transport officer | Search and page through vehicle service records |
| `GET` | `/api/service-history/stats` | Admin, transport officer | Fleet-wide service counts and spend summaries |
| `POST` | `/api/service-history` | Admin, transport officer | Record a service, repair, inspection, or scheduled maintenance |
| `PUT` | `/api/service-history/:id` | Admin, transport officer | Update a service record |
| `DELETE` | `/api/service-history/:id` | Admin | Delete a service record |
| `GET` | `/api/vehicle-assignments` | Admin, transport officer, transport user | List assignments; transport users see only their own requests |
| `GET` | `/api/vehicle-assignments/my-trips` | Driver | List the signed-in driver's assigned and completed trips |
| `PATCH` | `/api/vehicle-assignments/:id/trip-sheet` | Assigned driver | Append a time-stamped daily trip entry with odometer readings and optional fuel/notes; the assignment stays open |
| `GET` | `/api/vehicle-assignments/availability` | Admin, transport officer | Find unassigned vehicles and licensed drivers; optionally filter for a request's time window, capacity, and vehicle type |
| `POST` | `/api/vehicle-assignments` | Admin, transport officer, transport user | Create a schedule assignment or submit a user request |
| `PATCH` | `/api/vehicle-assignments/:id/assign` | Admin, transport officer | Assign an available vehicle and driver to a pending user request |
| `PATCH` | `/api/vehicle-assignments/:id/status` | Admin, transport officer, transport user | Reject, complete, cancel, or cancel one's own pending request |
| `GET` | `/api/vehicle-assignments/:id/trip-sheets` | Admin, transport officer, assigned driver | Review paginated daily trip entries with assignment, vehicle, and driver details |
| `POST` | `/api/vehicle-assignments/:id/trip-sheets` | Assigned driver | Submit a time-stamped daily trip entry |
| `GET` | `/api/advance-requests` | Admin, transport officer, driver | Page through all requests for fleet managers or only the signed-in driver's requests |
| `POST` | `/api/advance-requests` | Driver | Submit an advance request for an active assignment; accepts destination, distance in km, amount in whole rupees, purpose, and an optional JPG/PNG/WebP proof image (5 MB max) |
| `GET` | `/api/advance-requests/:id/proof` | Admin, transport officer, request owner | View an uploaded proof image |
| `PATCH` | `/api/advance-requests/:id/review` | Admin, transport officer | Approve (optionally with a different amount) or reject a pending request |
| `PATCH` | `/api/advance-requests/:id/acknowledge` | Admin, transport officer | Record the paid amount and issue a payment receipt for an approved request |

A driver is selected per assignment and is not stored on the vehicle master. A vehicle or driver with any active assignment is unavailable until an officer completes or cancels that assignment. Officer-created assignments do not require start/end times; transport-user requests retain their requested time window, and the officer's approval checks vehicle type, passenger capacity, driver licence validity, and current availability.

Drivers can submit multiple time-stamped trip entries against an active assignment. Transport officers review submitted entries and close the overall assignment when the trip is finished.

Trip advances are stored against the driver's active vehicle assignment. Each submission receives a generated `ADV-...` request receipt; admins and transport officers can inspect the request and uploaded proof, approve/reject it, then record payment acknowledgement. A successful acknowledgement receives a `PAY-...` payment receipt. Drivers can view their request and receipt history; rejected requests may be resubmitted. Only one pending, approved, or acknowledged request is allowed per assignment. Amounts are whole Indian rupees. No distance cutoff is applied because the institution's definition of a “long drive” has not been specified.

Service history records include a vehicle, service category and status, service date and odometer, work description, provider, cost, optional next-service date/odometer, and notes. List filters include search, vehicle, service type, status, and service-date range. Service records are kept in their own collection because a vehicle's maintenance history can grow over time.

Vehicle JSON fields: `type` (`bus` or `car`), `registrationNumber`, `make`, `model`, `year`, `capacity`, `fuelType` (`diesel`, `petrol`, `electric`, `hybrid`, `cng`, `other`), `status` (`active`, `maintenance`, `inactive`), and optional `assignedDriver` and `notes`.

Example account creation:

```json
{
  "name": "Fleet Operator",
  "email": "operator@example.com",
  "password": "a-unique-password-of-12-chars",
  "role": "operator"
}
```

Passwords are hashed with bcrypt. JWT signing keys must remain private. In production, serve the client and API over HTTPS so the session cookie is marked `Secure`.

Refresh tokens issued before server-side refresh-session tracking is deployed are not present in the new session collection. Plan for users to sign in again after deploying this change.
