# RouteCRMPro User Guide

A complete guide to using RouteCRMPro for managing propane and gas delivery operations.

---

## Overview

RouteCRMPro is a route-based delivery management system. The core workflow is:

1. **Add Distribution Centers** - Your warehouses/depots
2. **Add Customers** - Locations that receive deliveries
3. **Generate Routes** - Create optimized delivery routes for all customers at a DC
4. **Track Orders** - Record individual deliveries and billing

---

## Dashboard

The Dashboard provides an overview of your operations:

### Operations Map
- **Purple diamonds** = Distribution Centers
- **Blue/Green/Red dots** = Customers (color based on tank level)
- **Truck icons** = Delivery vehicles

### Map Features
- **Search bar**: Type an address to find and add as a customer
- **Click any business on map**: Add it as a customer directly
- **Weather radar**: Toggle precipitation overlay
- **Zoom to DC**: Click 📍 on any DC row

### Quick Stats
- Active Routes in progress
- Route Templates available
- Active Trucks
- Low Tank Alerts (customers below 25%)

---

## Customers

### Adding Customers

1. Click **+ Add Customer**
2. Required fields:
   - **Code**: Unique identifier (e.g., CUST-001)
   - **Name**: Customer name
3. **Address**: Use the autocomplete - it automatically captures:
   - Street address
   - City, State, ZIP
   - Latitude/Longitude (critical for routing!)
4. **Preferred DC**: Which distribution center services this customer
5. **Tank Info**: Tank size and current level
6. **Payment Terms**: Net 30, COD, etc.

### Quick Add from Map
On the Dashboard map:
- Search for an address, or
- Click any business/location on the map
- Click "Add as Customer" to quick-add with pre-filled address

### Customer Fields
| Field | Description |
|-------|-------------|
| Code | Unique identifier |
| Name | Customer/business name |
| Contact Name | Primary contact person |
| Email/Phone | Contact information |
| Address | Service address (use autocomplete!) |
| Preferred DC | Which DC services them |
| Customer Type | Residential, Commercial, Industrial |
| Tank Size | Tank capacity in gallons |
| Current Level | Current fill percentage |
| Price/Gallon | Customer-specific pricing |
| Payment Terms | Net 30, COD, Prepaid, etc. |
| Auto Delivery | Enable for keep-full service |
| Minimum Level | Auto-order trigger level |
| Delivery Instructions | Gate codes, access notes, etc. |

---

## Distribution Centers

Distribution Centers (DCs) are your warehouses or depots where trucks load product.

### Adding a DC
1. Click **+ Add DC**
2. Enter:
   - **Code**: DC-001, DC-FLORENCE, etc.
   - **Name**: Descriptive name
   - **Address**: Use autocomplete for coordinates!
   - **Manager**: Who runs this location
   - **Capacity**: Storage capacity in gallons

### DC Actions
- **📍 Show on Map**: Pan map to this DC
- **🌤️ Weather**: View forecast for this DC's area
- **🗺️ Routes**: Jump to route generation for this DC

---

## Generate Routes

This is the core feature - creating optimized delivery routes.

### How It Works

1. **Select Distribution Center** from dropdown
2. **See all customers** for that DC displayed on map (blue dots)
3. **Click "Generate Routes"**
4. System creates optimized routes using Google's Directions API

### What Happens
- All active customers with addresses are included
- Customers are grouped into routes (default: 15 stops max per route)
- Each route is optimized for shortest travel distance
- Routes start and end at the Distribution Center

### Activating Routes

After generating routes, you'll see each route with an **"Activate Route"** button:

1. **Click "🚀 Activate Route"** on any generated route
2. The route is saved to the database
3. Route appears in **Active Routes** with status "scheduled"
4. Click **"Activate All"** to activate all generated routes at once

Once activated, routes remain active until:
- Marked as completed
- Cancelled
- Modified

### Route Results
After generation, you'll see:
- **Total stops, miles, and estimated time**
- **Route cards** - click to view on map
- **Activate button** - save route to Active Routes
- **Stop details** - customer name, address, tank info, distance from previous stop

### Settings
Click ⚙️ Settings to adjust:
- **Max Stops Per Route**: 5-25 (Google API limit is 25)

### Viewing Routes
- Click a route card to display it on the map
- Numbered markers show stop sequence
- Purple line shows the route path
- Click any marker for customer details

---

## Active Routes

View and manage routes that have been activated.

### Route Statuses
| Status | Description |
|--------|-------------|
| **Scheduled** | Route is ready but not started |
| **In Progress** | Driver is actively running the route |
| **Completed** | All stops finished |
| **Cancelled** | Route was cancelled |

### Managing Active Routes

1. **View** - Click to see full route details with all stops
2. **Start** - Begin the route (changes status to "in_progress")
3. **Complete** - Mark route as finished

### Route Details View
When viewing an active route, you can see:
- All stops with customer info
- Tank levels before/after delivery
- Gallons delivered per stop
- Skip reasons if customer was skipped
- Total gallons and revenue

---

## Orders

Orders track individual deliveries and billing - separate from route planning.

### When to Use Orders
- Record actual deliveries made
- Track gallons delivered
- Manage billing and payments
- Schedule specific customer requests

### Creating an Order
1. Click **+ New Order**
2. Select **Customer**
3. Enter **Gallons Requested**
4. Set **Requested Date** and **Delivery Window**
5. Set **Priority** (Normal, High, Urgent)

### Order Fields
| Field | Description |
|-------|-------------|
| Customer | Who needs delivery |
| DC | Which DC fulfills it |
| Gallons Requested | Amount to deliver |
| Price/Gallon | Billing rate |
| Requested Date | When customer wants it |
| Scheduled Date | When it's planned |
| Delivery Window | Morning, Afternoon, Anytime |
| Priority | Normal, High, Urgent |
| Status | Pending → Scheduled → Delivered |

### Order vs Route
- **Route**: Where drivers go (all customers at a DC)
- **Order**: What gets delivered (specific customer request)

You can have routes without orders (routine keep-full service) or orders without routes (emergency delivery).

---

## Trucks

Track your delivery vehicles with comprehensive details.

### Truck Tabs
1. **Basic**: Code, name, make/model, VIN, license plate, assigned DC
2. **Weight**: GVWR, empty weight, axle weights, payload capacity
3. **Tank**: Capacity, material, inspection dates, working pressure
4. **Fuel**: Tank size, MPG, fuel type, DEF capacity
5. **Compliance**: DOT number, registration, inspections, IFTA/IRP
6. **Insurance**: Policy number, provider, coverage amounts
7. **Maintenance**: Odometer, service dates, oil change intervals
8. **Equipment**: GPS, ELD, dash cam, lift gate flags
9. **Costs**: Purchase price, monthly payment, insurance

### Key Fields for Operations
- **Capacity Gallons**: How much product the truck holds
- **Assigned Driver**: Who drives this truck
- **DC Assignment**: Which depot it's based at
- **GPS Tracking**: Current location on map

---

## Drivers

Manage driver profiles with compliance tracking.

### Driver Tabs
1. **Basic**: Name, email, phone, hire date, DC assignment
2. **Pay**: Hourly rate, overtime, per diem, pay type
3. **CDL**: License number, state, class, endorsements
4. **Medical**: DOT medical card, exam dates
5. **Background**: Background check, drug test, MVR status
6. **Training**: Certifications, training dates
7. **Emergency**: Emergency contact information
8. **Address**: Driver's home address

### Compliance Tracking
The system tracks expiration dates for:
- CDL license
- Medical card
- HAZMAT endorsement
- Background checks
- Drug tests

---

## Users

Manage who can access the system.

### User Roles
| Role | Access |
|------|--------|
| Admin | Full access to everything |
| Dispatch | Routes, orders, customers |
| Driver | Mobile route view (limited) |
| Accounting | Orders, billing, payments |
| Payroll | Driver records, pay info |

### Creating Users
1. Click **+ Add User**
2. Enter username, name, email
3. Set password
4. Select role
5. Optionally assign to specific DC or link to driver record

---

## Billing

View subscription and payment information.

### Tabs
- **Overview**: Current plan, usage stats
- **Invoices**: Payment history
- **Payment Method**: Manage credit card

---

## Tips & Best Practices

### Address Entry
**Always use the autocomplete** when entering addresses. This ensures:
- Correct formatting
- Accurate lat/lng coordinates (required for routing)
- Consistent data

### Route Planning
- Generate routes at the start of each day/week
- Adjust max stops based on your delivery times
- Review routes on map before dispatching

### Customer Data
- Keep tank sizes accurate for delivery planning
- Update current levels after deliveries
- Use delivery instructions for access notes

### Regular Maintenance
- Update truck odometers regularly
- Track driver certification expiration dates
- Review compliance alerts on dashboard

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Esc | Close modal |
| Enter | Submit form (when focused) |

---

## Getting Help

1. Check this guide first
2. Look for error messages in red
3. Use browser console (F12) for technical errors
4. Contact your system administrator
