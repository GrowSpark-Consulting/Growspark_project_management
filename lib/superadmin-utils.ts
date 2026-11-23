// Superadmin role by email: run on the server as the signed-in user (POST /api/admin/diagnostics).
/* eslint-disable @typescript-eslint/no-explicit-any */

import { logger } from './debug-logger'

interface SuperadminResult {
  success: boolean
  message: string
}

/**
 * Assign superadmin role to a user by email
 * @param email - Email address of the user to assign superadmin role to
 * @returns Promise that resolves with assignment result
 */
export async function assignSuperadminRoleByEmail(email: string, db: any): Promise<SuperadminResult> {
  try {
    const supabase = db
    if (!supabase) {
      throw new Error('Supabase not configured')
    }

    logger.info('Assigning superadmin role to email', { email })

    // First, find the user by email
    const { data: userData, error: userError } = await supabase
      .from('user_profiles')
      .select('id, email')
      .eq('email', email)
      .single()

    if (userError || !userData) {
      return { success: false, message: 'User not found' }
    }

    logger.debug('Found user', { userId: userData.id })

    // Ensure the System department exists
    const { data: deptData, error: deptError } = await supabase
      .from('departments')
      .select('id')
      .eq('name', 'System Administration')
      .single()

    if (deptError || !deptData) {
      return { success: false, message: 'System Administration department not found' }
    }

    // Ensure the Superadmin role exists
    const { data: roleData, error: roleError } = await supabase
      .from('roles')
      .select('id')
      .eq('name', 'Superadmin')
      .single()

    if (roleError || !roleData) {
      return { success: false, message: 'Superadmin role not found' }
    }

    // Check if user already has superadmin role
    const { data: existingRole, error: _checkError } = await supabase
      .from('user_roles')
      .select('id')
      .eq('user_id', userData.id)
      .eq('role_id', roleData.id)
      .single()

    if (existingRole) {
      return { success: true, message: 'User already has superadmin role' }
    }

    // Assign the superadmin role
    const { error: assignError } = await supabase
      .from('user_roles')
      .insert({
        user_id: userData.id,
        role_id: roleData.id,
        assigned_at: new Date().toISOString(),
        assigned_by: userData.id // Self-assigned for now
      })

    if (assignError) {
      logger.error('Error assigning superadmin role', {}, assignError as unknown as Error)
      return { success: false, message: `Failed to assign superadmin role: ${assignError.message}` }
    }

    logger.info('Superadmin role assigned successfully', { email })
    return { success: true, message: `Superadmin role assigned successfully to ${email}` }

  } catch (error: unknown) {
    logger.error('Error assigning superadmin role', {}, error as Error)
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Failed to assign superadmin role'
    }
  }
}

/**
 * Check if a user has superadmin role by email
 * @param email - Email address of the user to check
 * @returns Promise that resolves with check result
 */
export async function checkSuperadminRoleByEmail(email: string, db: any): Promise<SuperadminResult> {
  try {
    const supabase = db
    if (!supabase) {
      throw new Error('Supabase not configured')
    }

    // Find the user by email
    const { data: userData, error: userError } = await supabase
      .from('user_profiles')
      .select('id, email')
      .eq('email', email)
      .single()

    if (userError || !userData) {
      return { success: false, message: 'User not found' }
    }

    // Check if user has superadmin role
    const { data: roleData, error: roleError } = await supabase
      .from('user_roles')
      .select(`
        id,
        roles!inner(name)
      `)
      .eq('user_id', userData.id)
      .eq('roles.name', 'Superadmin')
      .single()

    if (roleError || !roleData) {
      return { success: true, message: `${email} does not have superadmin role` }
    }

    return { success: true, message: `${email} has superadmin role` }

  } catch (error: unknown) {
    logger.error('Error checking superadmin role', {}, error as Error)
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Failed to check superadmin role'
    }
  }
}

/**
 * Remove superadmin role from a user by email
 * @param email - Email address of the user to remove superadmin role from
 * @returns Promise that resolves with removal result
 */
export async function removeSuperadminRoleByEmail(email: string, db: any): Promise<SuperadminResult> {
  try {
    const supabase = db
    if (!supabase) {
      throw new Error('Supabase not configured')
    }

    // Find the user by email
    const { data: userData, error: userError } = await supabase
      .from('user_profiles')
      .select('id, email')
      .eq('email', email)
      .single()

    if (userError || !userData) {
      return { success: false, message: 'User not found' }
    }

    // Get the Superadmin role ID
    const { data: roleData, error: roleError } = await supabase
      .from('roles')
      .select('id')
      .eq('name', 'Superadmin')
      .single()

    if (roleError || !roleData) {
      return { success: false, message: 'Superadmin role not found' }
    }

    // Remove the superadmin role
    const { error: removeError } = await supabase
      .from('user_roles')
      .delete()
      .eq('user_id', userData.id)
      .eq('role_id', roleData.id)

    if (removeError) {
      logger.error('Error removing superadmin role', {}, removeError as unknown as Error)
      return { success: false, message: `Failed to remove superadmin role: ${removeError.message}` }
    }

    logger.info('Superadmin role removed successfully', { email })
    return { success: true, message: `Superadmin role removed successfully from ${email}` }

  } catch (error: unknown) {
    logger.error('Error removing superadmin role', {}, error as Error)
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Failed to remove superadmin role'
    }
  }
}
