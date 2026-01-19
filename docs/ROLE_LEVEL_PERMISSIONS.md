# 🔐 Role-Level Permission Management

## Overview

The permission system has a clear **hierarchical structure** where users can only grant or revoke roles that are **strictly below** their own level. Only **Admin** roles can manage permissions - **Manager** roles are for managing resources (creating/deleting), not permissions.

---

## 🎯 Core Principles

1. **Admins manage permissions** - Only CategoryAdmin and GroupAdmin can grant/revoke permissions
2. **Managers manage resources** - CategoryManager creates/deletes boards, GroupManager creates/deletes categories
3. **You cannot grant your own level or above** - Prevents privilege escalation
4. **Hierarchical visibility** - Lower roles can see parent resources but only their specific scope

---

## 📊 Role Hierarchy (by level)

| Level | Role                 | Scope    | Capabilities                                                                                     |
| ----- | -------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| 1     | BoardViewer          | Board    | View board, view parent category (only that board), view parent group (only that board/category) |
| 2     | BoardCollaborator    | Board    | Edit that board, same visibility as BoardViewer                                                  |
| 3     | CategoryViewer       | Category | View category and all boards in it, view parent group                                            |
| 4     | CategoryCollaborator | Category | Edit all boards in the category                                                                  |
| 5     | CategoryManager      | Category | Create/rename/delete boards in the category                                                      |
| 6     | CategoryAdmin        | Category | Manage category permissions/invites (can grant levels 1-5)                                       |
| 7     | GroupViewer          | Group    | View all categories and all nested boards                                                        |
| 8     | GroupCollaborator    | Group    | Edit all boards in all categories                                                                |
| 9     | GroupManager         | Group    | Create/rename/delete categories and boards                                                       |
| 10    | GroupAdmin           | Group    | Manage group permissions/invites (can grant levels 1-9)                                          |
| 11    | Developer            | Global   | Full access to everything                                                                        |

---

## ✅ Permission Management Rules

### Who Can Manage Permissions

**Only Admin roles can manage permissions:**

| Your Role         | Can Manage Permissions For                        |
| ----------------- | ------------------------------------------------- |
| **CategoryAdmin** | Their category and all boards in their category   |
| **GroupAdmin**    | Their group, all categories in it, and all boards |
| **Developer**     | Everything (global access)                        |

**Manager roles CANNOT manage permissions:**

- CategoryManager creates/deletes boards but CANNOT grant permissions
- GroupManager creates/deletes categories but CANNOT grant permissions

### Role-Level Restrictions

#### CategoryAdmin (Level 6)

- ✅ **Can grant/revoke:** All board and category roles below level 6 (levels 1-5)
  - BoardViewer, BoardCollaborator
  - CategoryViewer, CategoryCollaborator, CategoryManager
- ❌ **Cannot grant/revoke:** CategoryAdmin or above (levels 6+)
- 📍 **Scope:** Their category and all boards within it
- 🎫 **Can create invites:** Yes, for their category and boards

#### GroupAdmin (Level 10)

- ✅ **Can grant/revoke:** All roles below level 10 (levels 1-9)
  - All board roles (BoardViewer, BoardCollaborator)
  - All category roles (CategoryViewer, CategoryCollaborator, CategoryManager, CategoryAdmin)
  - GroupViewer, GroupCollaborator, GroupManager
- ❌ **Cannot grant/revoke:** GroupAdmin (level 10)
- 📍 **Scope:** Their group, all categories within it, and all boards
- 🎫 **Can create invites:** Yes, for their group, categories, and boards

#### Developer (Level 11)

- ✅ **Can grant/revoke:** Any role at any level
- 📍 **Scope:** Global access to everything
- 🎫 **Can create invites:** Yes, for everything

---

## 🔍 Examples

### Example 1: CategoryAdmin

```
User: Alice (CategoryAdmin - Level 6)
Target: Marketing Category

✅ Alice can grant CategoryManager to Bob (level 5)
✅ Alice can grant CategoryCollaborator to Carol (level 4)
✅ Alice can grant BoardViewer to anyone for boards in her category (level 1)
✅ Alice can revoke CategoryViewer from Dave (level 3)
✅ Alice can create invites for her category with any role level 1-5
❌ Alice CANNOT grant/revoke CategoryAdmin (same level 6)
❌ Alice CANNOT grant/revoke GroupViewer (level 7, outside her scope)
```

### Example 2: GroupAdmin

```
User: Bob (GroupAdmin - Level 10)
Target: Engineering Group

✅ Bob can grant GroupManager to anyone (level 9)
✅ Bob can grant CategoryAdmin to any category (level 6)
✅ Bob can grant any board or category role (levels 1-6)
✅ Bob can revoke GroupCollaborator from anyone (level 8)
✅ Bob can create invites for his group, categories, and boards
❌ Bob CANNOT grant/revoke GroupAdmin (same level 10)
❌ Bob CANNOT promote anyone to his level
```

### Example 3: CategoryManager vs CategoryAdmin

```
CategoryManager (Carol - Level 5):
✅ Can create new boards in the category
✅ Can rename boards
✅ Can delete boards
❌ CANNOT grant BoardViewer to anyone
❌ CANNOT create invites
❌ CANNOT manage any permissions

CategoryAdmin (Dave - Level 6):
✅ Everything CategoryManager can do (create/delete boards)
✅ Can grant BoardViewer, BoardCollaborator
✅ Can grant CategoryViewer, CategoryCollaborator, CategoryManager
✅ Can create invites for the category
✅ Can manage all permissions for the category (levels 1-5)
```

### Example 4: GroupManager vs GroupAdmin

```
GroupManager (Eve - Level 9):
✅ Can create new categories in the group
✅ Can rename categories
✅ Can delete categories
✅ Can create/delete boards
❌ CANNOT grant any roles
❌ CANNOT create invites
❌ CANNOT manage any permissions

GroupAdmin (Frank - Level 10):
✅ Everything GroupManager can do (create/delete categories and boards)
✅ Can grant any role level 1-9
✅ Can create invites for the group, categories, and boards
✅ Can manage all permissions for the group (levels 1-9)
```

---

### Where It's Applied

1. **Permission Granting** ([permissions.ts](../src/routes/permissions.ts))
   - `/permissions/grant` endpoint validates role level before granting

2. **Permission Revoking** ([permissions.ts](../src/routes/permissions.ts))
   - `/permissions/revoke` endpoint validates role level before revoking

3. **Invite Creation** ([invites.ts](../src/routes/invites.ts))
   - `/invites` POST endpoint validates role level when creating invites

### Who Can Manage Permissions?

The `canManagePermissions` function determines who can manage permissions:

```typescript
switch (resource.type) {
  case "board":
    return role === CategoryAdmin || GroupAdmin || Developer;
  case "category":
    return role === CategoryAdmin || GroupAdmin || Developer;
  case "group":
    return role === GroupAdmin || Developer;
}
```

**Key point:** CategoryManager and GroupManager are NOT included - they manage resources, not permissions.

### Validation Flow

For each permission operation:

1. Check if user has permission to manage the resource (`canManagePermissions`)
   - This checks if user is CategoryAdmin, GroupAdmin, or Developer
2. Get the user's highest role for that resource (`getUserHighestRole`)
3. Validate they can grant/revoke the target role (`canGrantRole`)
   - This checks if targetLevel < granterLevel
4. If all checks pass, perform the operation

---

## 🚨 Error Messages

When validation fails, users receive clear feedback:

- **Not an admin:** `"You do not have permission to manage permissions for this {resource}."`
- **Granting too high:** `"You cannot grant {role} role. You can only grant roles below your own level."`
- **Revoking too high:** `"You cannot revoke {role} role. You can only manage roles below your own level."`

---

## 💡 Key Takeaways

1. **Admin vs Manager distinction:**
   - **Admin** = manage permissions (CategoryAdmin, GroupAdmin)
   - **Manager** = manage resources (CategoryManager, GroupManager)

2. **Strict hierarchy:** You can only affect roles with level < your level

3. **Scope matters:**
   - CategoryAdmin manages their category and boards
   - GroupAdmin manages their group, categories, and boards

4. **No self-promotion:** Cannot grant your own level or above

5. **Applies everywhere:** Granting, revoking, and invites all follow these rules

6. **Developer override:** Developers (level 11) bypass all restrictions

7. **Security first:** Prevents privilege escalation and unauthorized access

---

## 🔄 Updates Required When...

If you add a new role:

1. Update `PermissionHierarchy` in [permissions.ts](../src/other/permissions.ts)
2. Add to appropriate `Role` enum in Prisma schema
3. Update `getAccessLevel` function if the role has special access patterns
4. Update this documentation with the new role level and capabilities

If you change permission management logic:

1. Ensure `canGrantRole` is called in all permission-modifying operations
2. Ensure only Admin roles can call `canManagePermissions`
3. Test with users at different role levels
4. Update error messages if needed

---

## 📝 Quick Reference Table

| Role                 | Level | Create Resources       | Edit Content  | Manage Permissions | Create Invites |
| -------------------- | ----- | ---------------------- | ------------- | ------------------ | -------------- |
| BoardViewer          | 1     | ❌                     | ❌            | ❌                 | ❌             |
| BoardCollaborator    | 2     | ❌                     | ✅ Board only | ❌                 | ❌             |
| CategoryViewer       | 3     | ❌                     | ❌            | ❌                 | ❌             |
| CategoryCollaborator | 4     | ❌                     | ✅ All boards | ❌                 | ❌             |
| CategoryManager      | 5     | ✅ Boards              | ✅ All boards | ❌                 | ❌             |
| CategoryAdmin        | 6     | ✅ Boards              | ✅ All boards | ✅ Levels 1-5      | ✅             |
| GroupViewer          | 7     | ❌                     | ❌            | ❌                 | ❌             |
| GroupCollaborator    | 8     | ❌                     | ✅ All boards | ❌                 | ❌             |
| GroupManager         | 9     | ✅ Categories & Boards | ✅ All boards | ❌                 | ❌             |
| GroupAdmin           | 10    | ✅ Categories & Boards | ✅ All boards | ✅ Levels 1-9      | ✅             |
| Developer            | 11    | ✅ Everything          | ✅ Everything | ✅ All levels      | ✅             |
