export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      assistant_actions: {
        Row: {
          action_type: string
          created_at: string
          executed_at: string | null
          id: string
          message_id: string
          payload: Json
          position: number
          result_event_id: string | null
          result_inbox_item_id: string | null
          result_task_id: string | null
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          action_type: string
          created_at?: string
          executed_at?: string | null
          id?: string
          message_id: string
          payload: Json
          position: number
          result_event_id?: string | null
          result_inbox_item_id?: string | null
          result_task_id?: string | null
          state?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          action_type?: string
          created_at?: string
          executed_at?: string | null
          id?: string
          message_id?: string
          payload?: Json
          position?: number
          result_event_id?: string | null
          result_inbox_item_id?: string | null
          result_task_id?: string | null
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assistant_actions_message_owner_fkey"
            columns: ["message_id", "user_id"]
            isOneToOne: false
            referencedRelation: "assistant_messages"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "assistant_actions_result_event_owner_fkey"
            columns: ["result_event_id", "user_id"]
            isOneToOne: false
            referencedRelation: "calendar_events"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "assistant_actions_result_inbox_owner_fkey"
            columns: ["result_inbox_item_id", "user_id"]
            isOneToOne: false
            referencedRelation: "inbox_items"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "assistant_actions_result_task_owner_fkey"
            columns: ["result_task_id", "user_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      assistant_conversations: {
        Row: {
          created_at: string
          id: string
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      assistant_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          role: string
          user_id: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          role: string
          user_id?: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assistant_messages_conversation_owner_fkey"
            columns: ["conversation_id", "user_id"]
            isOneToOne: false
            referencedRelation: "assistant_conversations"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      calendar_events: {
        Row: {
          all_day: boolean
          created_at: string
          description: string | null
          end_time: string | null
          event_date: string
          external_id: string | null
          id: string
          location: string | null
          project_id: string | null
          source: string
          start_time: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          all_day?: boolean
          created_at?: string
          description?: string | null
          end_time?: string | null
          event_date: string
          external_id?: string | null
          id?: string
          location?: string | null
          project_id?: string | null
          source?: string
          start_time?: string | null
          title: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          all_day?: boolean
          created_at?: string
          description?: string | null
          end_time?: string | null
          event_date?: string
          external_id?: string | null
          id?: string
          location?: string | null
          project_id?: string | null
          source?: string
          start_time?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_events_project_owner_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      canvas_assignment_preferences: {
        Row: {
          canvas_assignment_id: string
          canvas_assignment_name: string | null
          canvas_course_id: string
          created_at: string
          id: string
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          canvas_assignment_id: string
          canvas_assignment_name?: string | null
          canvas_course_id: string
          created_at?: string
          id?: string
          state: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          canvas_assignment_id?: string
          canvas_assignment_name?: string | null
          canvas_course_id?: string
          created_at?: string
          id?: string
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      canvas_course_links: {
        Row: {
          canvas_course_code: string | null
          canvas_course_id: string
          canvas_course_name: string | null
          created_at: string
          id: string
          project_id: string | null
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          canvas_course_code?: string | null
          canvas_course_id: string
          canvas_course_name?: string | null
          created_at?: string
          id?: string
          project_id?: string | null
          state: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          canvas_course_code?: string | null
          canvas_course_id?: string
          canvas_course_name?: string | null
          created_at?: string
          id?: string
          project_id?: string | null
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "canvas_course_links_project_owner_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      canvas_sync_state: {
        Row: {
          consecutive_failures: number
          created_at: string
          last_attempt_at: string | null
          last_courses_count: number
          last_error_code: string | null
          last_finished_at: string | null
          last_ignored_count: number
          last_imported_count: number
          last_result: string | null
          last_review_count: number
          last_skipped_count: number
          last_success_at: string | null
          last_trigger: string | null
          last_unchanged_count: number
          last_updated_count: number
          lease_token: string | null
          lease_until: string | null
          next_eligible_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          consecutive_failures?: number
          created_at?: string
          last_attempt_at?: string | null
          last_courses_count?: number
          last_error_code?: string | null
          last_finished_at?: string | null
          last_ignored_count?: number
          last_imported_count?: number
          last_result?: string | null
          last_review_count?: number
          last_skipped_count?: number
          last_success_at?: string | null
          last_trigger?: string | null
          last_unchanged_count?: number
          last_updated_count?: number
          lease_token?: string | null
          lease_until?: string | null
          next_eligible_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          consecutive_failures?: number
          created_at?: string
          last_attempt_at?: string | null
          last_courses_count?: number
          last_error_code?: string | null
          last_finished_at?: string | null
          last_ignored_count?: number
          last_imported_count?: number
          last_result?: string | null
          last_review_count?: number
          last_skipped_count?: number
          last_success_at?: string | null
          last_trigger?: string | null
          last_unchanged_count?: number
          last_updated_count?: number
          lease_token?: string | null
          lease_until?: string | null
          next_eligible_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      google_calendar_connections: {
        Row: {
          access_token_ciphertext: string | null
          access_token_expires_at: string | null
          connected_at: string
          created_at: string
          google_account_email: string | null
          id: string
          refresh_token_ciphertext: string | null
          selected_calendar_id: string | null
          selected_calendar_name: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token_ciphertext?: string | null
          access_token_expires_at?: string | null
          connected_at?: string
          created_at?: string
          google_account_email?: string | null
          id?: string
          refresh_token_ciphertext?: string | null
          selected_calendar_id?: string | null
          selected_calendar_name?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          access_token_ciphertext?: string | null
          access_token_expires_at?: string | null
          connected_at?: string
          created_at?: string
          google_account_email?: string | null
          id?: string
          refresh_token_ciphertext?: string | null
          selected_calendar_id?: string | null
          selected_calendar_name?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      google_calendar_item_links: {
        Row: {
          calendar_event_id: string | null
          content_hash: string
          created_at: string
          google_calendar_id: string
          google_event_id: string
          id: string
          item_type: string
          last_synced_at: string
          task_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          calendar_event_id?: string | null
          content_hash: string
          created_at?: string
          google_calendar_id: string
          google_event_id: string
          id?: string
          item_type: string
          last_synced_at?: string
          task_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          calendar_event_id?: string | null
          content_hash?: string
          created_at?: string
          google_calendar_id?: string
          google_event_id?: string
          id?: string
          item_type?: string
          last_synced_at?: string
          task_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "google_calendar_item_links_event_owner_fkey"
            columns: ["calendar_event_id", "user_id"]
            isOneToOne: false
            referencedRelation: "calendar_events"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "google_calendar_item_links_task_owner_fkey"
            columns: ["task_id", "user_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      google_calendar_sync_state: {
        Row: {
          consecutive_failures: number
          created_at: string
          last_attempt_at: string | null
          last_created_count: number
          last_deleted_count: number
          last_failed_count: number
          last_finished_at: string | null
          last_imported_count: number
          last_result: string | null
          last_success_at: string | null
          last_trigger: string | null
          last_unchanged_count: number
          last_updated_count: number
          lease_token: string | null
          lease_until: string | null
          next_eligible_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          consecutive_failures?: number
          created_at?: string
          last_attempt_at?: string | null
          last_created_count?: number
          last_deleted_count?: number
          last_failed_count?: number
          last_finished_at?: string | null
          last_imported_count?: number
          last_result?: string | null
          last_success_at?: string | null
          last_trigger?: string | null
          last_unchanged_count?: number
          last_updated_count?: number
          lease_token?: string | null
          lease_until?: string | null
          next_eligible_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          consecutive_failures?: number
          created_at?: string
          last_attempt_at?: string | null
          last_created_count?: number
          last_deleted_count?: number
          last_failed_count?: number
          last_finished_at?: string | null
          last_imported_count?: number
          last_result?: string | null
          last_success_at?: string | null
          last_trigger?: string | null
          last_unchanged_count?: number
          last_updated_count?: number
          lease_token?: string | null
          lease_until?: string | null
          next_eligible_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      inbox_items: {
        Row: {
          content: string | null
          created_at: string
          external_id: string | null
          id: string
          kind: string
          project_id: string | null
          source: string
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          content?: string | null
          created_at?: string
          external_id?: string | null
          id?: string
          kind: string
          project_id?: string | null
          source?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          content?: string | null
          created_at?: string
          external_id?: string | null
          id?: string
          kind?: string
          project_id?: string | null
          source?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbox_items_project_owner_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      notification_deliveries: {
        Row: {
          attempts: number
          created_at: string
          dedupe_key: string
          event_id: string | null
          failure_code: string | null
          id: string
          kind: string
          scheduled_for: string
          sent_at: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          dedupe_key: string
          event_id?: string | null
          failure_code?: string | null
          id?: string
          kind: string
          scheduled_for: string
          sent_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          dedupe_key?: string
          event_id?: string | null
          failure_code?: string | null
          id?: string
          kind?: string
          scheduled_for?: string
          sent_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_deliveries_event_owner_fkey"
            columns: ["event_id", "user_id"]
            isOneToOne: false
            referencedRelation: "calendar_events"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          created_at: string
          event_lead_minutes: number
          event_reminders: boolean
          morning_summary: boolean
          push_enabled: boolean
          show_details: boolean
          tomorrow_tasks: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_lead_minutes?: number
          event_reminders?: boolean
          morning_summary?: boolean
          push_enabled?: boolean
          show_details?: boolean
          tomorrow_tasks?: boolean
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          event_lead_minutes?: number
          event_reminders?: boolean
          morning_summary?: boolean
          push_enabled?: boolean
          show_details?: boolean
          tomorrow_tasks?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          area: string | null
          created_at: string
          description: string | null
          id: string
          name: string
          progress: number
          source: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          area?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name: string
          progress?: number
          source?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          area?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          progress?: number
          source?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          expiration_time: string | null
          id: string
          last_seen_at: string
          p256dh: string
          updated_at: string
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          expiration_time?: string | null
          id?: string
          last_seen_at?: string
          p256dh: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          expiration_time?: string | null
          id?: string
          last_seen_at?: string
          p256dh?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      tasks: {
        Row: {
          completed_at: string | null
          created_at: string
          description: string | null
          due_date: string | null
          external_id: string | null
          id: string
          priority: string
          project_id: string | null
          source: string
          status: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          external_id?: string | null
          id?: string
          priority?: string
          project_id?: string | null
          source?: string
          status?: string
          title: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          external_id?: string | null
          id?: string
          priority?: string
          project_id?: string | null
          source?: string
          status?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_project_owner_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_assistant_reply: {
        Args: { p_actions?: Json; p_content: string; p_conversation_id: string }
        Returns: string
      }
      assistant_payload_date: {
        Args: { p_key: string; p_payload: Json }
        Returns: string
      }
      assistant_payload_text: {
        Args: { p_key: string; p_payload: Json }
        Returns: string
      }
      assistant_payload_time: {
        Args: { p_key: string; p_payload: Json }
        Returns: string
      }
      claim_canvas_sync: {
        Args: { p_lease_seconds: number; p_trigger: string }
        Returns: {
          claimed: boolean
          consecutive_failures: number
          lease_token: string
          reason: string
        }[]
      }
      claim_google_calendar_sync: {
        Args: { p_lease_seconds: number; p_trigger: string }
        Returns: {
          claimed: boolean
          consecutive_failures: number
          lease_token: string
          reason: string
        }[]
      }
      claim_notification_delivery: {
        Args: {
          p_dedupe_key: string
          p_event_id?: string
          p_kind: string
          p_scheduled_for: string
        }
        Returns: string
      }
      create_project_from_canvas_course: {
        Args: {
          p_area?: string
          p_canvas_course_code?: string
          p_canvas_course_id: string
          p_canvas_course_name?: string
          p_description?: string
          p_name: string
          p_status?: string
        }
        Returns: string
      }
      dismiss_assistant_action: {
        Args: { p_action_id: string }
        Returns: string
      }
      execute_assistant_action: {
        Args: { p_action_id: string }
        Returns: {
          item_id: string
          item_type: string
          outcome: string
        }[]
      }
      finish_canvas_sync: {
        Args: {
          p_courses?: number
          p_error_code?: string
          p_ignored?: number
          p_imported?: number
          p_lease_token: string
          p_next_eligible_seconds: number
          p_result: string
          p_review?: number
          p_skipped?: number
          p_unchanged?: number
          p_updated?: number
        }
        Returns: boolean
      }
      finish_google_calendar_sync: {
        Args: {
          p_created?: number
          p_deleted?: number
          p_failed?: number
          p_imported?: number
          p_lease_token: string
          p_next_eligible_seconds: number
          p_result: string
          p_unchanged?: number
          p_updated?: number
        }
        Returns: boolean
      }
      finish_notification_delivery: {
        Args: { p_failure_code?: string; p_id: string; p_status: string }
        Returns: boolean
      }
      get_google_calendar_credentials: {
        Args: never
        Returns: {
          access_token_ciphertext: string
          access_token_expires_at: string
          refresh_token_ciphertext: string
        }[]
      }
      save_notification_preferences: {
        Args: {
          p_event_lead_minutes: number
          p_event_reminders: boolean
          p_morning_summary: boolean
          p_push_enabled: boolean
          p_show_details: boolean
          p_tomorrow_tasks: boolean
        }
        Returns: undefined
      }
      save_push_subscription: {
        Args: {
          p_auth: string
          p_endpoint: string
          p_expiration_time?: string
          p_p256dh: string
        }
        Returns: string
      }
      scheduler_claim_canvas_sync: {
        Args: { p_lease_seconds: number; p_trigger: string; p_user_id: string }
        Returns: {
          claimed: boolean
          consecutive_failures: number
          lease_token: string
          reason: string
        }[]
      }
      scheduler_claim_google_calendar_sync: {
        Args: { p_lease_seconds: number; p_trigger: string; p_user_id: string }
        Returns: {
          claimed: boolean
          consecutive_failures: number
          lease_token: string
          reason: string
        }[]
      }
      scheduler_claim_notification_delivery: {
        Args: {
          p_dedupe_key: string
          p_event_id?: string
          p_kind: string
          p_scheduled_for: string
          p_user_id: string
        }
        Returns: string
      }
      scheduler_finish_canvas_sync: {
        Args: {
          p_courses?: number
          p_error_code?: string
          p_ignored?: number
          p_imported?: number
          p_lease_token: string
          p_next_eligible_seconds: number
          p_result: string
          p_review?: number
          p_skipped?: number
          p_unchanged?: number
          p_updated?: number
          p_user_id: string
        }
        Returns: boolean
      }
      scheduler_finish_google_calendar_sync: {
        Args: {
          p_created?: number
          p_deleted?: number
          p_failed?: number
          p_imported?: number
          p_lease_token: string
          p_next_eligible_seconds: number
          p_result: string
          p_unchanged?: number
          p_updated?: number
          p_user_id: string
        }
        Returns: boolean
      }
      scheduler_finish_notification_delivery: {
        Args: {
          p_failure_code?: string
          p_id: string
          p_status: string
          p_user_id: string
        }
        Returns: boolean
      }
      scheduler_get_google_calendar_credentials: {
        Args: { p_user_id: string }
        Returns: {
          access_token_ciphertext: string
          access_token_expires_at: string
          refresh_token_ciphertext: string
        }[]
      }
      scheduler_sync_canvas_course_tasks: {
        Args: {
          p_assignments: Json
          p_canvas_course_id: string
          p_user_id: string
        }
        Returns: {
          assignment_id: string
          outcome: string
        }[]
      }
      scheduler_sync_google_calendar_events: {
        Args: { p_calendar_id: string; p_events: Json; p_user_id: string }
        Returns: {
          event_id: string
          outcome: string
        }[]
      }
      set_canvas_assignment_preference: {
        Args: {
          p_canvas_assignment_id: string
          p_canvas_assignment_name?: string
          p_canvas_course_id: string
          p_state: string
        }
        Returns: number
      }
      sync_canvas_course_tasks: {
        Args: { p_assignments: Json; p_canvas_course_id: string }
        Returns: {
          assignment_id: string
          outcome: string
        }[]
      }
      sync_google_calendar_events: {
        Args: { p_calendar_id: string; p_events: Json }
        Returns: {
          event_id: string
          outcome: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
