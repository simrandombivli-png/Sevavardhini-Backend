-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.users (
  user_id integer NOT NULL DEFAULT nextval('users_user_id_seq'::regclass),
  user_name character varying NOT NULL,
  email character varying NOT NULL UNIQUE,
  password character varying,
  role character varying NOT NULL CHECK (role::text = ANY (ARRAY['Admin'::character varying, 'Project_Manager'::character varying, 'Coordinator'::character varying]::text[])),
  user_created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  user_updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  user_is_active boolean NOT NULL DEFAULT true,
  user_created_by integer,
  CONSTRAINT users_pkey PRIMARY KEY (user_id),
  CONSTRAINT users_user_created_by_fkey FOREIGN KEY (user_created_by) REFERENCES public.users(user_id)
);
CREATE TABLE public.projects (
  pro_id integer NOT NULL DEFAULT nextval('projects_pro_id_seq'::regclass),
  pro_title character varying NOT NULL,
  pro_description text,
  pro_domain character varying DEFAULT 'General'::character varying,
  pro_status character varying DEFAULT 'Planning'::character varying CHECK (pro_status::text = ANY (ARRAY['Planning'::character varying, 'Ongoing'::character varying, 'Completed'::character varying]::text[])),
  start_date date,
  end_date date,
  pro_managed_by integer,
  pro_created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  pro_updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  pro_is_archived boolean NOT NULL DEFAULT false,
  pro_archived_at timestamp with time zone,
  pro_archived_by integer,
  CONSTRAINT projects_pkey PRIMARY KEY (pro_id),
  CONSTRAINT projects_pro_managed_by_fkey FOREIGN KEY (pro_managed_by) REFERENCES public.users(user_id),
  CONSTRAINT projects_pro_archived_by_fkey FOREIGN KEY (pro_archived_by) REFERENCES public.users(user_id)
);
CREATE TABLE public.tasks (
  task_id integer NOT NULL DEFAULT nextval('tasks_task_id_seq'::regclass),
  project_id integer NOT NULL,
  task_title character varying NOT NULL,
  task_description text,
  task_assigned_to integer,
  task_status character varying DEFAULT 'Pending'::character varying CHECK (task_status::text = ANY (ARRAY['Pending'::character varying, 'In_Progress'::character varying, 'Completed'::character varying]::text[])),
  task_priority character varying DEFAULT 'Medium'::character varying CHECK (task_priority::text = ANY (ARRAY['Low'::character varying, 'Medium'::character varying, 'High'::character varying]::text[])),
  deadline date,
  task_created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  task_updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tasks_pkey PRIMARY KEY (task_id),
  CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(pro_id),
  CONSTRAINT tasks_task_assigned_to_fkey FOREIGN KEY (task_assigned_to) REFERENCES public.users(user_id)
);
CREATE TABLE public.user_invites (
  invite_id integer NOT NULL DEFAULT nextval('user_invites_invite_id_seq'::regclass),
  invite_user_id integer NOT NULL,
  invite_token_hash character varying NOT NULL UNIQUE,
  invite_expires_at timestamp with time zone NOT NULL,
  invite_used_at timestamp with time zone,
  invite_created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_invites_pkey PRIMARY KEY (invite_id),
  CONSTRAINT user_invites_invite_user_id_fkey FOREIGN KEY (invite_user_id) REFERENCES public.users(user_id)
);
CREATE TABLE public.project_coordinators (
  coord_project_id integer NOT NULL,
  coord_user_id integer NOT NULL,
  coord_assigned_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT project_coordinators_pkey PRIMARY KEY (coord_project_id, coord_user_id),
  CONSTRAINT project_coordinators_coord_user_id_fkey FOREIGN KEY (coord_user_id) REFERENCES public.users(user_id),
  CONSTRAINT project_coordinators_coord_project_id_fkey FOREIGN KEY (coord_project_id) REFERENCES public.projects(pro_id)
);
CREATE TABLE public.audit_logs (
  log_id integer NOT NULL DEFAULT nextval('audit_logs_log_id_seq'::regclass),
  log_user_id integer,
  log_action character varying NOT NULL,
  log_entity_type character varying NOT NULL,
  log_entity_id integer,
  log_details jsonb,
  log_created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT audit_logs_pkey PRIMARY KEY (log_id),
  CONSTRAINT audit_logs_log_user_id_fkey FOREIGN KEY (log_user_id) REFERENCES public.users(user_id)
);