# 🧩 Permissions & Access Control

This document defines how permissions work in the system and how access is propagated across **Boards**, **Categories**, and **Groups**.
It serves as a reference for developers, designers, and anyone implementing or reasoning about access rules.

---

## 📚 Overview

Access in the system is **hierarchical** and **contextual**.
Every resource, a **Board**, **Category**, or **Group**, can have roles assigned to users that determine what they can see or do.

Permissions are organized from most specific (Board) to broadest (Group → Global).

---

## ⚙️ Permission Hierarchy

| Level | Role                     | Description                                                       |
| ----- | ------------------------ | ----------------------------------------------------------------- |
| 1     | **BoardViewer**          | Can view a single board.                                          |
| 2     | **BoardCollaborator**    | Can edit board content.                                           |
| 3     | **CategoryViewer**       | Can view a category and its boards.                               |
| 4     | **CategoryCollaborator** | Can edit content in a category and its boards.                    |
| 5     | **CategoryManager**      | Can create/delete boards, manage collaborators.                   |
| 6     | **CategoryAdmin**        | Full control over a category and its boards.                      |
| 7     | **GroupViewer**          | Can view a group and all categories/boards inside it.             |
| 8     | **GroupCollaborator**    | Can edit content within a group’s categories and boards.          |
| 9     | **GroupManager**         | Can create/delete categories, manage collaborators in the group.  |
| 10    | **GroupAdmin**           | Full administrative control of the group and everything below it. |
| 11    | **Developer**            | Global role, full access to all resources.                        |

---

## 🧠 Permission Rules

### 1. Visibility (Downward Access)

If a user has a role on a resource:

- They can **see that resource**.
- If it’s a **Category** or **Group**, they can also **see all of its children** (recursively).

### 2. Upward Inheritance

If a user has access to a resource:

- **Board → Category**: A board-level user inherits equivalent visibility/access to its parent category.
- **Category → Group**: A category-level user inherits equivalent visibility/access to its parent group.
- Inherited access is **only for visibility/navigation**, not for managing or modifying the parent.

### 3. Fetching Rules

When fetching resources:

- **Boards**: Only include boards the user has access to (directly or through a category/group).
- **Categories**: Only include categories the user has access to (directly or through a group).
- **Groups**: Only include groups the user has access to.
- **Developers**: See everything, unfiltered.

---

## 🧩 Role Details

### 🗂 Board Roles

#### **BoardViewer**

- Can view the assigned board.
- Inherits view access to its parent category.
- Cannot edit or manage permissions.

#### **BoardCollaborator**

- Can view and edit board content.
- Inherits collaborator-level access to parent category.
- Cannot manage permissions.

---

### 📁 Category Roles

#### **CategoryViewer**

- Can view the category and all boards inside it.
- Inherits view access to parent group.

#### **CategoryCollaborator**

- Can edit content within the category and its boards.
- Inherits collaborator-level access to parent group.

#### **CategoryManager**

- Can create/delete boards, manage collaborators.
- Inherits manager-level access to parent group.

#### **CategoryAdmin**

- Full control over the category and all boards.
- Inherits admin-level access to parent group.

---

### 🧭 Group Roles

#### **GroupViewer**

- Can view the group and all its categories and boards.

#### **GroupCollaborator**

- Can edit content within the group’s categories and boards.

#### **GroupManager**

- Can manage categories and collaborators within the group.

#### **GroupAdmin**

- Full administrative control of the group and everything under it.

---

### 🌍 Global Role

#### **Developer**

- Full, unrestricted access to all resources.
- Bypasses all filtering and inheritance.

---

## 🔍 Example Scenarios

| Example                                       | Access Result                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| A user is a `BoardCollaborator` on _Board A_. | They can edit _Board A_ and view its parent _Category X_.                        |
| A user is a `CategoryViewer` on _Category Y_. | They can view _Category Y_, all boards under it, and its parent _Group Z_.       |
| A user is a `GroupManager` on _Group Alpha_.  | They can manage all categories and boards in _Group Alpha_ but not other groups. |
| A user is a `Developer`.                      | They can see and modify everything in the system.                                |
